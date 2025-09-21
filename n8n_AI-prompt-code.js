// Extract data from n8n input array
const items = $input.all();

// Find the TOTAL row for cash and equity
const totalRow = items.find(item => item.json.Ticker && item.json.Ticker.trim() === 'TOTAL');

// Count active positions (HOLD actions, excluding TOTAL)
const activePositions = items.filter(item => 
  item.json.Ticker && 
  item.json.Ticker.trim() !== 'TOTAL' && 
  item.json.Action === 'HOLD'
);

// Extract values - these DO exist in your TOTAL row
const cash = totalRow ? (totalRow.json['Cash Balance'] || 0) : 0;
const equity = totalRow ? (totalRow.json['Total Equity'] || 0) : 0;
const positions = activePositions.length;
// Use the portfolio date, not today's date
const date = items[0]?.json.Date?.trim() || new Date().toISOString().split('T')[0];

// Calculate portfolio performance metrics
const totalPnL = totalRow ? (totalRow.json.PnL || 0) : 0;
const startingEquity = 10000; // Assuming $10k start
const totalReturn = ((equity - startingEquity) / startingEquity * 100).toFixed(1);

// Build enhanced holdings text with stop losses and allocation percentages
const holdingsText = activePositions.map(item => {
  const ticker = item.json.Ticker?.trim() || 'UNKNOWN';
  const shares = item.json.Shares || 0;
  const buyPrice = item.json['Buy Price'] || 0;
  const currentPrice = item.json['Current Price'] || 0;
  const stopLoss = item.json['Stop Loss'] || 0;
  const pnl = item.json.PnL || 0;
  const positionValue = currentPrice * shares;
  const allocationPct = equity > 0 ? ((positionValue / equity) * 100).toFixed(1) : 0;
  
  return `${ticker}: ${shares} shares @ $${currentPrice} (Buy: $${buyPrice}, Stop: $${stopLoss}, P&L: $${pnl}, ${allocationPct}% allocation)`;
}).join('\n') || 'No current holdings';

// Build recent activity context (basic version - could be enhanced with historical data)
const recentActivityText = `Portfolio up $${totalPnL} (${totalReturn}%) from cost basis\nCurrent Strategy: Holding micro-cap positions with stop losses`;

const prompt = `You are a professional portfolio analyst. Here is your current portfolio state as of ${date}:

[ Holdings ]
${holdingsText}

[ Portfolio Performance ]
Total Return: ${totalReturn}% since inception
Cash Balance: $${cash.toLocaleString()}
Total Equity: $${equity.toLocaleString()}
Active Positions: ${positions}
Portfolio Started: ~$${startingEquity.toLocaleString()}

[ Recent Activity ]
${recentActivityText}

Rules:
- You have $${cash.toLocaleString()} in cash available for new positions
- Prefer U.S. micro-cap stocks (<$300M market cap)
- Full shares only, no options or derivatives
- Use stop-losses for risk management (current stops shown above)
- Be conservative with position sizing (max 25% per position)
- Consider liquidity for exit strategies

Analyze the current market conditions, portfolio concentration, and stop-loss levels. Provide specific trading recommendations.

Respond with ONLY a JSON object in this exact format:
{
    "analysis": "Brief market analysis and portfolio assessment",
    "trades": [
        {
            "action": "buy",
            "ticker": "SYMBOL", 
            "shares": 100,
            "price": 25.50,
            "stop_loss": 20.00,
            "reason": "Brief rationale including market cap and liquidity assessment"
        }
    ],
    "portfolio_adjustments": [
        {
            "action": "adjust_stop",
            "ticker": "EXISTING_SYMBOL",
            "new_stop_loss": 22.00,
            "reason": "Brief rationale for stop adjustment"
        }
    ],
    "confidence": 0.8
}

Only recommend trades you are confident about. If no trades are recommended, use empty arrays.`;

// Build structured position data for programmatic access
const currentPositions = activePositions.map(item => ({
  ticker: item.json.Ticker?.trim() || 'UNKNOWN',
  shares: item.json.Shares || 0,
  buy_price: item.json['Buy Price'] || 0,
  current_price: item.json['Current Price'] || 0,
  stop_loss: item.json['Stop Loss'] || 0,
  pnl: item.json.PnL || 0,
  allocation_pct: equity > 0 ? parseFloat(((item.json['Current Price'] * item.json.Shares) / equity * 100).toFixed(1)) : 0
}));

return {
  json: {
    prompt: prompt,
    cash_balance: cash,
    total_equity: equity,
    active_positions: positions,
    date: date,
    portfolio_performance: {
      total_return_pct: parseFloat(totalReturn),
      total_pnl: totalPnL,
      starting_equity: startingEquity
    },
    current_positions: currentPositions
  }
};

// Validation function for AI responses
function validateAIResponse(response, currentPositions) {
    const validation = {
        valid: true,
        warnings: [],
        errors: []
    };
    
    // Validate stop-loss adjustments
    response.portfolio_adjustments?.forEach(adj => {
        if (adj.action === 'adjust_stop') {
            const position = currentPositions.find(p => p.ticker === adj.ticker);
            if (!position) {
                validation.errors.push(`Stop adjustment for unknown ticker: ${adj.ticker}`);
                validation.valid = false;
            } else if (adj.new_stop_loss >= position.current_price) {
                validation.warnings.push(`New stop-loss for ${adj.ticker} ($${adj.new_stop_loss}) is above current price ($${position.current_price})`);
            }
        }
    });
    
    // Validate trades
    response.trades?.forEach(trade => {
        if (trade.action === 'buy' && trade.price <= 0) {
            validation.errors.push(`Invalid price for ${trade.ticker}: $${trade.price}`);
            validation.valid = false;
        }
    });
    
    return validation;
}
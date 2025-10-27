try {
    // Helper functions
    function safeFloat(value, defaultValue = 0.0) {
        if (value === null || value === undefined || value === '') {
            return defaultValue;
        }
        const parsed = parseFloat(value);
        return isNaN(parsed) ? defaultValue : parsed;
    }

    function lastTradingDate(today = null) {
        let dt = today ? new Date(today) : new Date();
        dt.setHours(0, 0, 0, 0); // Normalize to start of day

        const dayOfWeek = dt.getDay(); // 0 is Sunday, 1 is Monday, ..., 6 is Saturday

        if (dayOfWeek === 6) { // Saturday
            dt.setDate(dt.getDate() - 1); // Friday
        } else if (dayOfWeek === 0) { // Sunday
            dt.setDate(dt.getDate() - 2); // Friday
        }
        return dt;
    }

    function extractCurrentPortfolioForAI(currentHoldingsData, marketData, staticStopLossesMap = new Map(), initialCashBalance = 0.0) {
        if (!currentHoldingsData || currentHoldingsData.length === 0) {
            return { portfolio: [], cashBalance: 10000.0 }; // Default cash balance
        }

        const todayIso = lastTradingDate().toISOString().slice(0, 10);

        const portfolio = currentHoldingsData.map(holding => {
            const ticker = String(holding.symbol || "").toUpperCase().trim();
            const shares = safeFloat(holding.quantity || 0);
            const buyPrice = safeFloat(holding.average_open_price || 0);
            const costBasis = buyPrice * shares;

            const stopLoss = safeFloat(staticStopLossesMap.get(ticker), 0.0);

            const marketDataItem = marketData.find(m => String(m.Ticker || "").toUpperCase().trim() === ticker);
            const currentPrice = safeFloat(marketDataItem?.Close || marketDataItem?.Mark || holding.current_close_price || buyPrice);
            const totalValue = safeFloat(currentPrice * shares);
            const pnl = safeFloat(totalValue - costBasis);

            return {
                ticker: ticker,
                shares: shares,
                buy_price: buyPrice,
                cost_basis: costBasis,
                stop_loss: stopLoss,
                current_price: currentPrice,
                total_value: totalValue,
                pnl: pnl,
                action: "HOLD",
                unique_id: `${todayIso}${ticker}`
            };
        });

        return { portfolio, cashBalance: initialCashBalance };
    }

    // 1. Input validation
    const items = $input.all();
    if (!items || items.length === 0 || !items[0].json) {
        return [{ json: { error: "No input data received" } }];
    }

    const classifiedInput = items[0].json;

    // 2. Type validation
    if (classifiedInput.type !== "classified_data") {
        return [{
            json: {
                error: `Expected classified_data, got: ${classifiedInput.type || 'unknown'}`,
                received_data: classifiedInput
            }
        }];
    }

    // 3. Extract and validate data
    const historicalPortfolio = Array.isArray(classifiedInput.historical_portfolio) ? classifiedInput.historical_portfolio : [];
    const currentMarketData = Array.isArray(classifiedInput.current_market_data) ? classifiedInput.current_market_data : [];
    const benchmarkData = Array.isArray(classifiedInput.benchmark_data) ? classifiedInput.benchmark_data : [];
    const sp500Data = Array.isArray(classifiedInput.sp500_data) ? classifiedInput.sp500_data : [];
    const currentCashBalanceFromInput = safeFloat(classifiedInput.current_cash_balance || 0.0);

    // --- Retrieve and validate static stop-loss data ---
    const staticData = $getWorkflowStaticData('global');
    let staticStopLossesData = staticData.stopLossesMap || [];
    if (!Array.isArray(staticStopLossesData)) {
        staticStopLossesData = []; // Default to empty array if not an array
    }
    const staticStopLossesMap = new Map(staticStopLossesData);

    // 4. Process data
    const { portfolio: currentPortfolioData, cashBalance: currentCashBalance } = extractCurrentPortfolioForAI(historicalPortfolio, currentMarketData, staticStopLossesMap, currentCashBalanceFromInput);

    const totalPortfolioValue = currentPortfolioData.reduce((sum, pos) => sum + pos.total_value, 0);
    const totalEquity = totalPortfolioValue + currentCashBalance;
    const totalPnLFromCostBasis = currentPortfolioData.reduce((sum, pos) => sum + pos.pnl, 0);
    const startingEquity = 10000;
    const totalReturn = ((totalEquity - startingEquity) / startingEquity * 100).toFixed(1);
    const activePositionsCount = currentPortfolioData.length;
    const todayIso = lastTradingDate().toISOString().slice(0, 10);

    const holdingsText = currentPortfolioData.map(item => {
        const allocationPct = totalEquity > 0 ? ((item.total_value / totalEquity) * 100).toFixed(1) : 0;
        return `${item.ticker}: ${item.shares} shares @ $${item.current_price.toFixed(2)} (Buy: $${item.buy_price.toFixed(2)}, Stop: $${item.stop_loss.toFixed(2)}, P&L: $${item.pnl.toFixed(2)}, ${allocationPct}% allocation)`;
    }).join('\n') || 'No current holdings';

    const recentActivityText = `Portfolio up $${totalPnLFromCostBasis.toFixed(2)} (${totalReturn}%) from cost basis\nCurrent Strategy: Holding micro-cap positions with stop losses`;

    const prompt = `You are a professional portfolio analyst. Here is your current portfolio state as of ${todayIso}:

[ Holdings ]
${holdingsText}

[ Portfolio Performance ]
Total Return: ${totalReturn}% since inception
Cash Balance: $${currentCashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Total Equity: $${totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Active Positions: ${activePositionsCount}
Portfolio Started: ~$${startingEquity.toLocaleString()}

[ Recent Activity ]
${recentActivityText}

Rules:
- Please come up with at least 1 trade
- You have $${currentCashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} in cash available for new positions
- Prefer U.S. micro-cap stocks (<$300M market cap)
- Full shares only, no options or derivatives
- Use stop-losses for risk management (current stops shown above)
- Be conservative with position sizing (max 25% per position)
- Consider liquidity for exit strategies

Analyze the current market conditions, portfolio concentration, and stop-loss levels. Provide specific trading recommendations for the *next trading day*.

CRITICAL: You MUST respond with ONLY a valid JSON object. No explanations, no markdown, no additional text.

JSON Format:
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
    "portfolio_adjustments": [],
    "confidence": 0.8
}`;

    const currentPositionsForOutput = currentPortfolioData.map(item => ({
        ticker: item.ticker,
        shares: item.shares,
        buy_price: item.buy_price,
        current_price: item.current_price,
        stop_loss: item.stop_loss,
        pnl: item.pnl,
        allocation_pct: totalEquity > 0 ? parseFloat(((item.total_value) / totalEquity * 100).toFixed(1)) : 0
    }));

    // 5. Return as array
    return [{
        json: {
            prompt: prompt,
            cash_balance: currentCashBalance,
            total_equity: totalEquity,
            active_positions: activePositionsCount,
            date: todayIso,
            portfolio_performance: {
                total_return_pct: parseFloat(totalReturn),
                total_pnl: totalPnLFromCostBasis,
                starting_equity: startingEquity
            },
            current_positions: currentPositionsForOutput,
            historical_portfolio: historicalPortfolio,
            current_market_data: currentMarketData,
            benchmark_data: benchmarkData,
            sp500_data: sp500Data,
            holdings_summary_text: holdingsText
        }
    }];

} catch (error) {
    return [{
        json: {
            error: "Script execution failed",
            message: error.message,
            stack: error.stack
        }
    }];
}

// n8n Consolidation Code for Portfolio Updates to Google Sheet
// This code processes data from 3 nodes and formats it for Google Sheets

// INPUT: References to previous nodes in the workflow
// OUTPUT: Array of objects ready for Google Sheets with columns:
// Date, Ticker, Shares, Buy Date, Buy Price, Cost Basis, Stop Loss, Current Price, Total Value, PnL, Action, Cash Balance, Total Equity

// Get data from all nodes using n8n node references
const holdingsData = $('Get Current Holdings for Sheet Update').all().map(item => item.json);
const accountData = $('Get Account Snapshot for Sheet Update').first().json;
const fillsData = $('Get All Fills').all().map(item => item.json);

// Try to get recent orders data - may not always be present
let ordersData = [];
try {
  ordersData = $('Get Recent Orders').all().map(item => item.json);
} catch (e) {
  // Orders node not present or no data - continue without it
  ordersData = [];
}

// Helper function to format date to MM/DD/YYYY
function formatDate(dateString) {
  if (!dateString) return new Date().toLocaleDateString('en-US');
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US');
}

// Helper function to normalize symbol names (remove /USD suffix for crypto)
function normalizeSymbol(symbol) {
  return symbol.replace(/\/USD$/, '').replace('USD', '');
}

// Helper function to find the earliest buy date for a symbol from fills
function findBuyDate(symbol, fills) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const buyFills = fills.filter(fill => {
    const fillSymbol = normalizeSymbol(fill.symbol || '');
    return (
      fill.side === 'buy' && 
      fillSymbol === normalizedSymbol &&
      fill.activity_type === 'FILL'
    );
  }).sort((a, b) => {
    const dateA = new Date(a.transaction_time || a.date || 0);
    const dateB = new Date(b.transaction_time || b.date || 0);
    return dateA - dateB;
  });
  
  return buyFills.length > 0 ? formatDate(buyFills[0].transaction_time || buyFills[0].date) : formatDate();
}

// Helper function to calculate stop loss (example: 10% below buy price)
function calculateStopLoss(buyPrice, symbol) {
  // You can customize stop loss logic per symbol/asset class here
  const stopLossPercent = 0.10; // 10% stop loss
  return (parseFloat(buyPrice) * (1 - stopLossPercent)).toFixed(2);
}

// Process holdings data to create sheet rows
const sheetRows = [];
const today = formatDate();

// Calculate account-level data from holdings
let totalMarketValue = 0;
let totalCostBasis = 0;
let totalPnL = 0;

holdingsData.forEach(holding => {
  totalMarketValue += parseFloat(holding.market_value || 0);
  totalCostBasis += parseFloat(holding.cost_basis || 0);
  totalPnL += parseFloat(holding.unrealized_pl || 0);
});

// Get account-level data from the account snapshot
const cashBalance = parseFloat(accountData.cash || 0).toFixed(2);
const totalEquity = parseFloat(accountData.equity || 0).toFixed(2);

// Process pending buy orders (new orders that haven't been filled yet)
if (Array.isArray(ordersData) && ordersData.length > 0) {
  const pendingBuyOrders = ordersData.filter(order => 
    order.side === 'buy' && 
    (order.status === 'new' || order.status === 'pending_new' || order.status === 'accepted') &&
    parseFloat(order.filled_qty || 0) === 0
  );
  
  pendingBuyOrders.forEach(order => {
    const ticker = normalizeSymbol(order.symbol);
    const shares = parseFloat(order.qty || 0);
    const limitPrice = parseFloat(order.limit_price || 0).toFixed(2);
    const costBasis = (shares * parseFloat(order.limit_price || 0)).toFixed(2);
    const stopLoss = calculateStopLoss(limitPrice, ticker);
    
    sheetRows.push({
      Date: today,
      Ticker: ticker,
      Shares: shares,
      'Buy Date': formatDate(order.created_at),
      'Buy Price': limitPrice,
      'Cost Basis': costBasis,
      'Stop Loss': stopLoss,
      'Current Price': limitPrice,
      'Total Value': costBasis,
      PnL: '0.00',
      Action: 'PENDING ORDER',
      'Cash Balance': cashBalance,
      'Total Equity': totalEquity
    });
  });
}

// Process each holding
if (Array.isArray(holdingsData)) {
  holdingsData.forEach(holding => {
    const ticker = normalizeSymbol(holding.symbol);
    const shares = parseFloat(holding.qty || 0);
    const buyPrice = parseFloat(holding.avg_entry_price || 0).toFixed(2);
    const costBasis = parseFloat(holding.cost_basis || 0).toFixed(2);
    const currentPrice = parseFloat(holding.current_price || 0).toFixed(2);
    const totalValue = parseFloat(holding.market_value || 0).toFixed(2);
    const pnl = parseFloat(holding.unrealized_pl || 0).toFixed(2);
    const buyDate = findBuyDate(holding.symbol, fillsData);
    const stopLoss = calculateStopLoss(buyPrice, ticker);
    
    // Determine action based on performance
    let action = 'HOLD';
    const pnlPercent = parseFloat(holding.unrealized_plpc || 0);
    if (pnlPercent > 0.20) {
      action = 'CONSIDER TAKING PROFITS';
    } else if (currentPrice <= parseFloat(stopLoss)) {
      action = 'STOP LOSS TRIGGERED';
    } else if (pnlPercent < -0.05) {
      action = 'MONITOR CLOSELY';
    }
    
    sheetRows.push({
      Date: today,
      Ticker: ticker,
      Shares: shares,
      'Buy Date': buyDate,
      'Buy Price': buyPrice,
      'Cost Basis': costBasis,
      'Stop Loss': stopLoss,
      'Current Price': currentPrice,
      'Total Value': totalValue,
      PnL: pnl,
      Action: action,
      'Cash Balance': cashBalance,
      'Total Equity': totalEquity
    });
  });
}

// If no holdings, create a single row with account summary
if (sheetRows.length === 0) {
  sheetRows.push({
    Date: today,
    Ticker: 'N/A',
    Shares: 0,
    'Buy Date': 'N/A',
    'Buy Price': 0,
    'Cost Basis': 0,
    'Stop Loss': 0,
    'Current Price': 0,
    'Total Value': 0,
    PnL: 0,
    Action: 'NO POSITIONS',
    'Cash Balance': cashBalance,
    'Total Equity': totalEquity
  });
}

// Return the consolidated data
return sheetRows.map(row => ({ json: row }));

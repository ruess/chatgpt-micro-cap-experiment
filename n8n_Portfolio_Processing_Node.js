/**
 * n8n Trading Portfolio Processor - ENHANCED MODE
 * Uses TastyTrade data (including after-hours) for all price calculations.
 */

// Data Ingestion Service for n8n Trading Processor
// Permanent version with direct node access for reliable data retrieval.
// Enhanced debugging for TastyTrade data flow.

/**
 * Returns the last trading date (Mon–Fri), mapping Sat/Sun -> Fri.
 * @param {Date | null} today - The date to start from. Defaults to current date if null.
 * @returns {Date} The last trading date.
 */
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
  
  // Helper function to safely convert to float (moved to global scope)
  function safeFloat(value, defaultValue = 0.0) {
      if (value === null || value === undefined || value === '') {
          return defaultValue;
      }
      const parsed = parseFloat(value);
      return isNaN(parsed) ? defaultValue : parsed;
  }
  
  // Helper function to safely convert to string (moved to global scope)
  function safeString(value, defaultValue = "") {
      if (value === null || value === undefined) {
          return defaultValue;
      }
      return String(value).trim();
  }
  
  function processTradingPortfolio() {
      try {
          const todayIso = lastTradingDate().toISOString().slice(0, 10); // YYYY-MM-DD format for Date fields
  
          // NEW: Create a YYYYMMDD format for UniqueIDs, consistent with historical data
          const dateObjForId = lastTradingDate();
          const yearId = dateObjForId.getFullYear();
          const monthId = (dateObjForId.getMonth() + 1).toString().padStart(2, '0');
          const dayId = dateObjForId.getDate().toString().padStart(2, '0');
          const todayYYYYMMDD = `${yearId}${monthId}${dayId}`; // YYYYMMDD format for UniqueIDs
  
          // Get input data from Data Ingestion Node
          const inputItems = $input.all(); // Use n8n's $input.all() to get input data
  
          if (!inputItems || inputItems.length === 0) {
              return [{ json: { error: "No input data received from Data Ingestion Node" } }];
          }
  
          // Get the classified data from the first input item
          const classifiedInput = inputItems[0].json;
  
          // Validate that we received classified data by checking for a key field
          if (!classifiedInput.hasOwnProperty('historical_portfolio')) {
              return [{
                  json: {
                      error: `Expected classified data from Data Ingestion Node, but 'historical_portfolio' is missing.`,
                      received_data: classifiedInput
                  }
              }];
          }
  
          // Extract classified data
          let historicalPortfolio = classifiedInput.historical_portfolio || [];
          const currentMarketData = classifiedInput.current_market_data || [];
          const benchmarkData = classifiedInput.benchmark_data || [];
          let sp500Data = classifiedInput.sp500_data || [];
          const debugInfo = classifiedInput.debug_info || {};
          let currentCashBalance = safeFloat(classifiedInput.cash_balance, 10000.0); // Get cash balance from classified data, default to 10000
  
          // NEW: Extract AI recommendations
          const aiTrades = classifiedInput.ai_trades || [];
          const aiPortfolioAdjustments = classifiedInput.ai_portfolio_adjustments || [];
          const aiAnalysis = classifiedInput.ai_analysis || "No AI analysis provided.";
          const aiConfidence = classifiedInput.ai_confidence || null;
  
          // Data summary
          const dataSummary = {
              historical_portfolio_count: historicalPortfolio.length,
              current_market_data_count: currentMarketData.length,
              benchmark_data_count: benchmarkData.length,
              sp500_data_count: sp500Data.length,
              market_tickers_found: currentMarketData.map(item => item.Ticker),
              benchmark_tickers_found: benchmarkData.map(item => item.Ticker),
              ai_trades_count: aiTrades.length, // NEW
              ai_adjustments_count: aiPortfolioAdjustments.length // NEW
          };
  
          // Check if we have the required data
          if (!historicalPortfolio || historicalPortfolio.length === 0) {
              return [{
                  json: {
                      error: "No current holdings data found in classified input. Ensure 'Parse Current Holdings' is working and connected.",
                      debug_info: debugInfo,
                      data_summary: dataSummary,
                      received_data_keys: Object.keys(classifiedInput)
                  }
              }];
          }

          // --- Retrieve static stop-loss data ---
          const staticData = $getWorkflowStaticData('global');
          const staticStopLossesMap = new Map(staticData.stopLossesMap || []);
          const staticTakeProfitMap = new Map(staticData.takeProfitMap || []);

          // --- Dynamically add stop-losses for new positions if not already set ---
          let updatedStaticStopLosses = false;
          historicalPortfolio.forEach(holding => {
              const ticker = String(holding.symbol || "").toUpperCase();
              if (ticker && !staticStopLossesMap.has(ticker)) {
                  // Calculate a default stop-loss (e.g., 10% below average open price)
                  const defaultStopLoss = safeFloat(holding.average_open_price || holding.current_close_price, 0) * 0.90; // 10% below open/close price
                  if (defaultStopLoss > 0) { // Only add if a valid default can be calculated
                      staticStopLossesMap.set(ticker, parseFloat(defaultStopLoss.toFixed(2)));
                      updatedStaticStopLosses = true;
                      debugInfo.new_stop_loss_added = debugInfo.new_stop_loss_added || [];
                      debugInfo.new_stop_loss_added.push({ ticker: ticker, default_stop_loss: parseFloat(defaultStopLoss.toFixed(2)), reason: "Automatically added for new position" });
                  }
              }
          });
          // Explicitly reassign the map if it was updated, to ensure n8n saves changes
          if (updatedStaticStopLosses) {
              staticData.stopLossesMap = staticStopLossesMap;
          }

          // Create a map for quick lookup of current market data
          const marketDataMap = new Map();
          currentMarketData.forEach(item => {
              marketDataMap.set(item.Ticker.toUpperCase(), item);
          });

          let currentPortfolio = historicalPortfolio.map(holding => {
              const ticker = String(holding.symbol || "").toUpperCase().trim();
              const shares = safeFloat(holding.quantity || 0);
              const buyPrice = safeFloat(holding.average_open_price || 0);
              const costBasis = buyPrice * shares; // Simple cost basis

              // Retrieve stop_loss from the provided map, or default to 0
              const stopLoss = safeFloat(staticStopLossesMap.get(ticker), 0.0);
              const takeProfit = safeFloat(staticTakeProfitMap.get(ticker), 0.0);

              // Get current market price from currentMarketData, default to historical close or buy price if not found
              const marketItem = marketDataMap.get(ticker);
              const currentPrice = safeFloat(marketItem?.Close || holding.current_close_price || buyPrice);
              const totalValue = currentPrice * shares;
              const pnl = totalValue - costBasis;

              return {
                  ticker: ticker,
                  shares: shares,
                  buy_price: buyPrice,
                  cost_basis: costBasis,
                  stop_loss: stopLoss,
                  take_profit: takeProfit,
                  current_price: currentPrice,
                  total_value: totalValue,
                  pnl: pnl,
                  action: "HOLD", // Assume hold for AI unless specifically sold in prev step
                  unique_id: `${todayYYYYMMDD}${ticker}` // Generate unique ID for this context
              };
          });

          let cashBalance = currentCashBalance; // Use the cash balance fetched from API
  
            // NEW: Apply AI recommended stop-loss adjustments BEFORE processing positions
            for (const adjustment of aiPortfolioAdjustments) {
                if (adjustment.action === "adjust_stop") {
                    const positionToAdjust = currentPortfolio.find(p => p.ticker.toUpperCase() === adjustment.ticker.toUpperCase());
                    if (positionToAdjust) {
                        const oldStopLoss = positionToAdjust.stop_loss; // Capture old value first
                        positionToAdjust.stop_loss = adjustment.new_stop_loss;
                        // Add a debug message for the adjustment
                        debugInfo.ai_adjustments = debugInfo.ai_adjustments || [];
                        debugInfo.ai_adjustments.push({
                            ticker: adjustment.ticker,
                            old_stop_loss: oldStopLoss, // Log the captured old value
                            new_stop_loss: adjustment.new_stop_loss,
                            reason: adjustment.reason,
                            status: "applied"
                        });
                } else {
                      debugInfo.ai_adjustments = debugInfo.ai_adjustments || [];
                      debugInfo.ai_adjustments.push({
                          ticker: adjustment.ticker,
                          reason: adjustment.reason,
                          status: "skipped - position not found"
                      });
                  }
              } else if (adjustment.action === "adjust_take_profit") {
                const positionToAdjust = currentPortfolio.find(p => p.ticker.toUpperCase() === adjustment.ticker.toUpperCase());
                if (positionToAdjust) {
                    const oldTakeProfit = positionToAdjust.take_profit;
                    positionToAdjust.take_profit = adjustment.new_take_profit;
                    debugInfo.ai_adjustments = debugInfo.ai_adjustments || [];
                    debugInfo.ai_adjustments.push({
                        ticker: adjustment.ticker,
                        old_take_profit: oldTakeProfit,
                        new_take_profit: adjustment.new_take_profit,
                        reason: adjustment.reason,
                        status: "applied"
                    });
                } else {
                    debugInfo.ai_adjustments.push({
                        ticker: adjustment.ticker,
                        reason: adjustment.reason,
                        status: "skipped - position not found"
                    });
                }
            }
          }
  
          // Process market data (API Service data - available 24/7)
          const marketDataDict = {};
          for (const item of currentMarketData) {
              const ticker = item.Ticker;
              // Assuming the item itself contains the OHLCV and Date, similar to how it was used in processPortfolioPositions
              marketDataDict[ticker] = {
                  Open: item.Open,
                  High: item.High,
                  Low: item.Low,
                  Close: item.Close,
                  Volume: item.Volume || 0,
                  Date: item.Date
              };
          }
  
          // Process portfolio positions (including stop-loss triggers)
          let { portfolio: processedPortfolio, cash: interimCash, results: portfolioResults } = processPortfolioPositions(
              currentPortfolio, cashBalance, marketDataDict
          );
  
          // NEW: Apply AI recommended buy trades AFTER processing existing positions
          let finalCash = interimCash;
          for (const trade of aiTrades) {
              if (trade.action === "buy") {
                  let ticker = trade.ticker.toUpperCase();
                  // Standardize crypto tickers to end with 'USD' if they are common symbols
                  const commonCryptos = new Set(["BTC", "ETH", "SOL", "AVAX", "DOGE", "ADA", "MATIC"]);
                  if (commonCryptos.has(ticker) && !ticker.endsWith('USD')) {
                      ticker = `${ticker}USD`;
                  }
                  const shares = safeFloat(trade.shares, 0);
                  const price = safeFloat(trade.price, 0);
                  const stopLoss = safeFloat(trade.stop_loss, 0);
                  const reason = trade.reason || "AI recommended buy";
  
                  const costBasis = shares * price;
                  const totalValue = shares * price; // At purchase, value equals cost
  
                  // Basic validation and cash check
                  if (shares > 0 && price > 0 && finalCash >= totalValue) {
                      finalCash -= totalValue;
                      processedPortfolio.push({
                          ticker: ticker,
                          shares: shares,
                          buy_price: price,
                          cost_basis: costBasis,
                          stop_loss: stopLoss,
                          unique_id: `${todayYYYYMMDD}${ticker}`, // Use YYYYMMDD for consistency
                          current_price: price, // Set current price to purchase price
                          total_value: totalValue,
                          pnl: 0, // PnL is 0 at purchase
                          action: "BUY - AI Recommendation"
                      });
                      // Add to results for Google Sheet update
                      portfolioResults.push({
                          Date: todayIso, Ticker: ticker, Shares: shares,
                          "Buy Price": price, "Cost Basis": costBasis, "Stop Loss": stopLoss,
                          "Current Price": price, "Total Value": totalValue, PnL: 0,
                          Action: "BUY - AI Recommendation", "Cash Balance": "", "Total Equity": "",
                          UniqueID: `${todayYYYYMMDD}${ticker}`,
                          Reason: reason // Add AI reason
                      });
                      // Add debug message
                      debugInfo.ai_trades_executed = debugInfo.ai_trades_executed || [];
                      debugInfo.ai_trades_executed.push({
                          ticker: ticker,
                          shares: shares,
                          price: price,
                          stop_loss: stopLoss,
                          reason: reason,
                          status: "executed"
                      });
                  } else {
                      debugInfo.ai_trades_executed = debugInfo.ai_trades_executed || [];
                      debugInfo.ai_trades_executed.push({
                          ticker: ticker,
                          shares: shares,
                          price: price,
                          stop_loss: stopLoss,
                          reason: reason,
                          status: "skipped",
                          message: finalCash < totalValue ? "Insufficient cash" : "Invalid shares or price"
                      });
                  }
              }
          }
          
          // Ensure that any newly bought positions are also included in the portfolioResults for the TOTAL row calculation
          // and subsequent Google Sheet updates.
          // We need to re-calculate totalValue and totalPnL after AI trades and before TOTAL row.
          
          // Calculate final portfolio value and PnL directly from the processedPortfolio
          const finalPortfolioValue = processedPortfolio.reduce((sum, pos) => sum + safeFloat(pos.total_value || 0), 0);
          // Calculate total PnL from all portfolio updates, including sales
          const finalPnLFromAllUpdates = portfolioResults.reduce((sum, item) => {
              if (item.Ticker !== "TOTAL") { // Only exclude the TOTAL row itself
                  return sum + safeFloat(item.PnL || 0);
              }
              return sum;
          }, 0);
  
          // Remove the old TOTAL row if it exists before adding the new one
          portfolioResults = portfolioResults.filter(item => item.Ticker !== "TOTAL");
  
          // Add the new total row based on updated portfolio and cash
          const finalTotalEquity = parseFloat((finalPortfolioValue + finalCash).toFixed(2));
          const finalTotalRow = {
              Date: todayIso, Ticker: "TOTAL", Shares: "", "Buy Price": "",
              "Cost Basis": "", "Stop Loss": "", "Current Price": "",
              "Total Value": parseFloat(finalPortfolioValue.toFixed(2)), PnL: parseFloat(finalPnLFromAllUpdates.toFixed(2)),
              Action: "", "Cash Balance": parseFloat(finalCash.toFixed(2)), "Total Equity": finalTotalEquity,
              UniqueID: `${todayYYYYMMDD}TOTAL`
          };
          portfolioResults.push(finalTotalRow);
  
  
          // Combine all market data for performance metrics
          const allMarketDict = { ...marketDataDict };
  
          // Add benchmark data if available
          for (const item of benchmarkData) {
              const ticker = item.Ticker;
              allMarketDict[ticker] = {
                  Open: item.Open,
                  High: item.High,
                  Low: item.Low,
                  Close: item.Close,
                  Volume: item.Volume || 0,
                  Date: item.Date
              };
          }
  
          // Process S&P 500 data
          let sp500ProcessedData = [];
          if (sp500Data && sp500Data.length > 0) {
              sp500ProcessedData = sp500Data.map(item => ({
                  ...item,
                  Date: new Date(item.Date)
              })).sort((a, b) => a.Date.getTime() - b.Date.getTime());
          }
  
          // Calculate performance metrics
          const performanceMetrics = calculatePerformanceMetrics(
              historicalPortfolio, // Pass original historicalPortfolio as array of objects
              portfolioResults, // Use the updated portfolioResults for metrics
              allMarketDict,
              sp500ProcessedData, // Pass processed S&P 500 data
              10000.0 // Default starting equity
          );
  
          // Return results in proper n8n format
          const results = [];
  
          // Add each portfolio update as a separate item
          for (const update of portfolioResults) {
              results.push({ json: { type: "portfolio_update", ...update } });
          }
  
          // Add AI analysis as a separate item (NEW)
          results.push({ json: { type: "ai_analysis_summary", analysis: aiAnalysis, confidence: aiConfidence } });
  
          // Add performance metrics as a separate item
          results.push({ json: { type: "performance_metrics", ...performanceMetrics } });
  
          // Add updated portfolio state (use processedPortfolio which includes AI buys)
          if (processedPortfolio && processedPortfolio.length > 0) {
              for (const row of processedPortfolio) {
                  // Ensure this output also reflects the correct values after processing
                  // and AI trades/adjustments.
                   const finalPositionState = {
                      ticker: row.ticker,
                      shares: row.shares,
                      buy_price: row.buy_price,
                      cost_basis: row.cost_basis,
                      stop_loss: row.stop_loss,
                      current_price: row.current_price, // Should be updated during processing
                      total_value: row.total_value,      // Should be updated during processing
                      pnl: row.pnl,                      // Should be updated during processing
                      action: row.action,
                      unique_id: row.unique_id
                  };
                  results.push({ json: { type: "portfolio_state", ...finalPositionState } });
              }
          }
  
  
          // Add summary item with debug info
          results.push({
              json: {
                  type: "summary",
                  portfolio_updates_count: portfolioResults.length,
                  final_cash_balance: finalCash,
                  processing_date: new Date().toISOString(),
                  debug_info: debugInfo,
                  data_summary: dataSummary,
                  market_data_tickers: Object.keys(marketDataDict),
                  data_source: "Alpaca_API_Mode",
                  success: true
              }
          });
  
          return results;
  
      } catch (e) {
          return [{
              json: {
                  error: `Processing failed: ${e.message}`,
                  type: "error",
                  traceback: e.stack, // In JS, stack provides similar info to traceback
                  input_data_available: (typeof inputItems !== 'undefined' ? inputItems.length : 0)
              }
          }];
      }
  }
  
  // The 'extractCurrentPortfolio' function has been removed as data is now directly ingested from TastyTrade API.
  // This streamlines the data flow and eliminates the need for Google Sheet specific parsing.
  
  // The `processPortfolioPositions` function needs to be aware of the *current* stop_loss
  // values which might have been adjusted by the AI. We don't need to change its signature
  // as `portfolio` already contains the adjusted stop losses.
  // We also need to ensure that when we update currentPortfolio after a sell,
  // we are actually returning the modified portfolio.
  function processPortfolioPositions(portfolio, cash, marketData) {
      const todayIso = lastTradingDate().toISOString().slice(0, 10); // YYYY-MM-DD format
      let results = [];
      let currentPortfolio = [...portfolio]; // Create a mutable copy of the portfolio (includes AI adjustments)
      let currentCash = cash;
  
      let totalValue = 0.0;
      let totalPnL = 0.0;
  
      // Process each position
      let remainingPortfolio = []; // To build the portfolio after sells
      for (const position of currentPortfolio) {
          const ticker = String(position.ticker || "").toUpperCase();
  
          const shares = safeFloat(position.shares, 0);
          const buyPrice = safeFloat(position.buy_price, 0.0);
          const costBasis = safeFloat(position.cost_basis, buyPrice * shares);
          const stopLoss = safeFloat(position.stop_loss, 0.0); // Use potentially adjusted stop-loss
          const takeProfit = safeFloat(position.take_profit, 0.0); // Get take-profit
          const uniqueId = String(position.unique_id || "");
  
          // Skip empty ticker rows
          if (!ticker) {
              continue; // Skip if ticker is empty or null
          }
  
          // Get market data for this ticker
          const tickerData = marketData[ticker]; // marketData is now an object of objects
  
          if (!tickerData || Object.keys(tickerData).length === 0) {
              // Only show error if market data is completely unavailable
              const result = {
                  Date: todayIso, Ticker: ticker, Shares: shares,
                  "Buy Price": buyPrice, "Cost Basis": costBasis, "Stop Loss": stopLoss,
                  "Current Price": "", "Total Value": "", PnL: "",
                  Action: "ERROR - NO MARKET DATA (Check if ticker is being fetched by Get Portfolio Asset Snapshots node)", "Cash Balance": "", "Total Equity": "",
                  UniqueID: uniqueId
              };
              results.push(result);
              remainingPortfolio.push(position); // Keep in portfolio if no data
              continue;
          }
  
          // Get OHLC data from TastyTrade (available after hours and weekends)
          // Assuming tickerData is already the latest data object (not a DataFrame)
          const openPrice = safeFloat(tickerData.Open || tickerData.Close, 0);
          const highPrice = safeFloat(tickerData.High || tickerData.Close, 0);
          const lowPrice = safeFloat(tickerData.Low || tickerData.Close, 0);
          const closePrice = safeFloat(tickerData.Close, 0);
  
          let action = "HOLD"; // Default to HOLD
          let execPrice = closePrice; // Default to close price
          let value;
          let pnl;
  
          // Check for stop loss trigger using daily low price
          if (stopLoss > 0 && lowPrice <= stopLoss) {
              action = "SELL - Stop Loss Triggered";
              execPrice = Math.min(openPrice, stopLoss); // Execute at stop loss or open if below
              execPrice = parseFloat(execPrice.toFixed(2));
              value = parseFloat((execPrice * shares).toFixed(2));
              pnl = parseFloat(((execPrice - buyPrice) * shares).toFixed(2));
              currentCash += value;
              // Position is sold, do not add to remainingPortfolio
          } else if (takeProfit > 0 && highPrice >= takeProfit) {
              action = "SELL - Take Profit Triggered";
              execPrice = Math.max(openPrice, takeProfit); // Execute at take profit or open if gapped up
              execPrice = parseFloat(execPrice.toFixed(2));
              value = parseFloat((execPrice * shares).toFixed(2));
              pnl = parseFloat(((execPrice - buyPrice) * shares).toFixed(2));
              currentCash += value;
              // Position is sold, do not add to remainingPortfolio
          } else {
              // Stop loss not triggered - use TastyTrade close price
              execPrice = parseFloat(closePrice.toFixed(2));
              value = parseFloat((execPrice * shares).toFixed(2));
              pnl = parseFloat(((execPrice - buyPrice) * shares).toFixed(2));
              // Update the position object with current market data
              position.current_price = execPrice;
              position.total_value = value;
              position.pnl = pnl;
              remainingPortfolio.push(position); // Keep in portfolio
          }
  
          // For HOLD actions, add to total_value and total_pnl
          if (action === "HOLD") {
              totalValue += value;
              totalPnL += pnl;
          }
  
          const result = {
              Date: todayIso, Ticker: ticker, Shares: shares,
              "Buy Price": buyPrice, "Cost Basis": costBasis, "Stop Loss": stopLoss, "Take Profit": takeProfit,
              "Current Price": execPrice, "Total Value": value, PnL: pnl,
              Action: action, "Cash Balance": "", "Total Equity": "",
              UniqueID: uniqueId
          };
          results.push(result);
      }
  
      // Add total row
      const totalEquity = parseFloat((totalValue + currentCash).toFixed(2));
      const totalRow = {
          Date: todayIso, Ticker: "TOTAL", Shares: "", "Buy Price": "",
          "Cost Basis": "", "Stop Loss": "", "Current Price": "",
          "Total Value": parseFloat(totalValue.toFixed(2)), PnL: parseFloat(totalPnL.toFixed(2)),
          Action: "", "Cash Balance": parseFloat(currentCash.toFixed(2)), "Total Equity": totalEquity,
          UniqueID: `${todayIso}TOTAL`
      };
      results.push(totalRow);
  
      // Return the remaining portfolio (after sells) and the updated cash
      return { portfolio: remainingPortfolio, cash: currentCash, results: results };
  }
  
  function calculatePerformanceMetrics(historicalPortfolio, currentResults, marketData, sp500Data, startingEquity) {
      /**Calculate basic performance metrics. */
      const todayIso = lastTradingDate().toISOString().slice(0, 10);
  
      // Get current equity
      let currentEquity = startingEquity;
      let cashBalance = 0.0;
  
      if (currentResults) {
          const totalRow = currentResults.find(r => r.Ticker === "TOTAL");
          if (totalRow) {
              currentEquity = totalRow["Total Equity"] || startingEquity;
              cashBalance = totalRow["Cash Balance"] || 0.0;
          }
      }
  
      // Basic metrics
      return {
          date: todayIso,
          current_equity: currentEquity,
          cash_balance: cashBalance,
          total_positions: currentResults.filter(r => r.Ticker !== "TOTAL").length,
          positions_with_data: currentResults.filter(r => r.Action !== "ERROR - NO TASTYTRADE DATA" && r.Ticker !== "TOTAL").length,
          positions_without_data: currentResults.filter(r => r.Action === "ERROR - NO TASTYTRADE DATA").length,
                  data_source: "Alpaca_API_Mode"
      };
  }
  
  // Execute the main function
  return processTradingPortfolio();

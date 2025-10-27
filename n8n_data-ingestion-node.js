// Data Ingestion Service for n8n Trading Processor
// Uses named node access to fetch data from previous nodes and handles multiple data formats.

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

/**
 * Main data ingestion function for n8n with named node access.
 * @returns {Promise<any[]>} An array of n8n items containing classified data or an error.
 */
return (async function() {
    try {
        // --- Initialize data containers ---
        let currentHoldingsData = [];
        let portfolioMarketData = [];
        let benchmarkMarketData = [];
        let allMarketData = [];
        let fetchedCashBalance = 0.0;

        // --- Fetch data explicitly from each source node by name ---
        const holdingsItems = $('Parse Current Holdings').all();
        currentHoldingsData = holdingsItems.map(i => i.json);
        const portfolioTickers = new Set(currentHoldingsData.map(h => h.symbol.toUpperCase()));


        const portfolioMarketItems = $('Get Portfolio Asset Snapshots').all();
        const parsedPortfolioData = portfolioMarketItems
            .filter(item => item.json)
            .flatMap(item => {
                if (item.json.snapshots) {
                    // Handle crypto format, which has a 'snapshots' key
                    const snapshots = item.json.snapshots;
                    return Object.keys(snapshots).map(ticker => {
                        const standardizedTicker = ticker.replace('/', ''); // Convert 'BTC/USD' to 'BTCUSD'
                        return { ...snapshots[ticker], symbol: standardizedTicker };
                    });
                } else if (Object.keys(item.json).length > 0) {
                    // Handle stock format, which has the ticker as the key
                    const ticker = Object.keys(item.json)[0];
                    const data = item.json[ticker];
                    if (data) { // Ensure data exists for the ticker
                        return { ...data, symbol: ticker };
                    }
                }
                return []; // Return empty array for items that don't match known formats
            });
        portfolioMarketData.push(...parsedPortfolioData);

        const benchmarkMarketItems = $('Market Data Benchmark Summary Node').all();
        const parsedBenchmarkData = benchmarkMarketItems
            .filter(item => item.json)
            .flatMap(item => {
                return Object.keys(item.json).map(ticker => ({
                    ...item.json[ticker],
                    symbol: ticker
                }));
            });
        benchmarkMarketData.push(...parsedBenchmarkData);

        const accountSnapshotItems = $('Get Account Snapshot').all();
        if (accountSnapshotItems.length > 0 && accountSnapshotItems[0].json && accountSnapshotItems[0].json.cash) {
            fetchedCashBalance = parseFloat(accountSnapshotItems[0].json.cash);
        }

        // --- Combine all data sources ---
        allMarketData.push(...portfolioMarketData, ...benchmarkMarketData);

        // --- Process and classify all combined market data ---
        const seenSymbols = new Set();
        const uniqueMarketData = allMarketData.filter(item => {
            const symbol = item.symbol || '';
            if (!symbol || seenSymbols.has(symbol)) {
                return false;
            }
            seenSymbols.add(symbol);
            return true;
        });

        const sp500Tickers = new Set(['^GSPC', 'SPY', '^SPX']);

        let classifiedData = {
            historical_portfolio: currentHoldingsData,
            current_market_data: [],
            benchmark_data: [],
            sp500_data: [],
            current_cash_balance: fetchedCashBalance,
        };

        for (const marketItem of uniqueMarketData) {
            const ticker = (marketItem.symbol || '').toUpperCase();
            if (!ticker || ['BY-TYPE', 'UNKNOWN'].includes(ticker)) {
                continue;
            }
            
            const standardizedItem = {
                Ticker: ticker,
                Date: marketItem.dailyBar?.t ? new Date(marketItem.dailyBar.t).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
                Open: parseFloat(marketItem.dailyBar?.o || 0),
                High: parseFloat(marketItem.dailyBar?.h || 0),
                Low: parseFloat(marketItem.dailyBar?.l || 0),
                Close: parseFloat(marketItem.dailyBar?.c || marketItem.latestTrade?.p || 0),
                Volume: parseFloat(marketItem.dailyBar?.v || 0),
                PrevClose: parseFloat(marketItem.prevDailyBar?.c || 0),
                DataSource: 'Alpaca_Snapshot_API',
            };
            
            if (sp500Tickers.has(ticker)) {
                classifiedData.sp500_data.push(standardizedItem);
            } else if (portfolioTickers.has(ticker)) {
                classifiedData.current_market_data.push(standardizedItem);
            } else {
                classifiedData.benchmark_data.push(standardizedItem);
            }
        }
        
        // --- Return classified data in n8n format ---
        return [{
            json: {
                type: "classified_data",
                ...classifiedData
            }
        }];
        
    } catch (e) {
        console.error(`Data ingestion failed: ${e.message}`);
        return [{
            json: {
                type: "error",
                error: `Data ingestion failed: ${e.message}`,
                traceback: e.stack,
                timestamp: new Date().toISOString()
            }
        }];
    }
})();

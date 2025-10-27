/**
 * n8n - Alpaca Order Formatter
 *
 * This script takes portfolio update objects and reformats them into order
 * requests suitable for the Alpaca Trading API.
 *
 * It handles two primary cases:
 * 1. AI-recommended buys: Creates a 'bracket' order (a limit buy that triggers a stop-loss sell).
 * 2. Stop-loss sells: Creates a 'market' order to exit a position.
 */

const items = $input.all();
const alpacaOrders = [];

for (const item of items) {
    const data = item.json;

    // We only care about portfolio updates that represent a trade.
    // Ignore non-trade items like 'TOTAL' rows or summaries.
    if (data.type !== 'portfolio_update' || !data.Action || data.Ticker === 'TOTAL') {
        continue;
    }

    const action = data.Action;
    let order = null;

    const ticker = data.Ticker;
    // Simple assumption: if the ticker ends with 'USD' and is longer than 4 chars, it's crypto.
    const isCrypto = ticker.endsWith('USD') && ticker.length > 4;
    const symbol = isCrypto ? `${ticker.slice(0, -3)}/USD` : ticker;

    if (action === 'BUY - AI Recommendation') {
        const limitPrice = data['Buy Price'];
        const stopLossPrice = data['Stop Loss'];

        if (isCrypto) {
            // For crypto, create a simple limit buy order.
            // Bracket orders are not typically supported for crypto on Alpaca.
            order = {
                symbol: symbol,
                qty: data.Shares,
                side: 'buy',
                type: 'limit',
                time_in_force: 'gtc',
                limit_price: limitPrice,
                current_price: data['Current Price'] // Add current price for upcoming nodes
            };
        } else {
            // For stocks, create a bracket order as before.
            const riskPerShare = limitPrice - stopLossPrice;
            const rewardPerShare = riskPerShare * 2;
            const takeProfitPrice = limitPrice + rewardPerShare;

            order = {
                symbol: symbol,
                qty: data.Shares,
                side: 'buy',
                type: 'limit',
                time_in_force: 'gtc', // Good 'Til Canceled
                limit_price: limitPrice,
                order_class: 'bracket',
                stop_loss: {
                    stop_price: parseFloat(stopLossPrice.toFixed(2))
                },
                current_price: data['Current Price'], // Add current price for upcoming nodes
                take_profit: {
                    limit_price: parseFloat(takeProfitPrice.toFixed(2))
                }
            };
        }
    } else if (action === 'SELL - Stop Loss Triggered') {
        // Create a market sell order.
        // For crypto, time_in_force must be 'gtc' or 'ioc'. 'day' is invalid.
        order = {
            symbol: symbol,
            qty: data.Shares,
            side: 'sell',
            type: 'market',
            time_in_force: isCrypto ? 'gtc' : 'day',
            current_price: data['Current Price'] // Add current price for upcoming nodes
        };
    }

    if (order) {
        // Wrap the formatted order in the n8n item structure
        alpacaOrders.push({ json: order });
    }
}

return alpacaOrders;

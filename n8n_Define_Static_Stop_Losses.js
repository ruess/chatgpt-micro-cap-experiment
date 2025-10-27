// n8n_Define_Static_Stop_Losses.js - DYNAMIC VERSION
// This node dynamically ensures that every current holding has a default
// stop-loss and take-profit target defined in the workflow's static data.

// --- Configuration ---
const DEFAULT_STOP_LOSS_PERCENTAGE = 0.85; // 15% stop-loss from buy price
const DEFAULT_RISK_REWARD_RATIO = 2; // e.g., 2:1 reward-to-risk ratio

// Helper function to safely parse floats
function safeFloat(value, defaultValue = 0.0) {
    if (value === null || value === undefined || value === '') return defaultValue;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
}

// --- Main Logic ---
try {
    // 1. Fetch current holdings directly from the 'Parse Current Holdings' node
    const currentHoldings = $('Parse Current Holdings').all();
    
    if (!currentHoldings.length) {
        return [{ json: { message: "No current holdings found. No stop-losses to define.", status: "no_holdings" } }];
    }

    // 2. Retrieve existing static data maps, or create new ones
    const staticData = $getWorkflowStaticData('global');
    const stopLossesMap = new Map(staticData.stopLossesMap || []);
    const takeProfitMap = new Map(staticData.takeProfitMap || []);

    let updated = false;
    const logs = [];

    // 3. Iterate through each current holding
    for (const item of currentHoldings) {
        const holding = item.json;
        const ticker = holding.symbol?.toUpperCase();
        
        if (!ticker) continue;

        const buyPrice = safeFloat(holding.average_open_price, 0);
        if (buyPrice <= 0) continue; // Cannot set stops for free assets

        // 4. Check and define stop-loss if missing
        if (!stopLossesMap.has(ticker)) {
            const defaultStopLoss = buyPrice * DEFAULT_STOP_LOSS_PERCENTAGE;
            stopLossesMap.set(ticker, parseFloat(defaultStopLoss.toFixed(2)));
            updated = true;
            logs.push(`New default stop-loss for ${ticker} set to ${defaultStopLoss.toFixed(2)}.`);
        }

        // 5. Check and define take-profit if missing (based on stop-loss)
        if (!takeProfitMap.has(ticker)) {
            const stopLoss = stopLossesMap.get(ticker); // Use the (potentially new) stop-loss
            const risk = buyPrice - stopLoss;
            const reward = risk * DEFAULT_RISK_REWARD_RATIO;
            const defaultTakeProfit = buyPrice + reward;
            
            takeProfitMap.set(ticker, parseFloat(defaultTakeProfit.toFixed(2)));
            updated = true;
            logs.push(`New default take-profit for ${ticker} set to ${defaultTakeProfit.toFixed(2)} (2:1 R/R).`);
        }
    }

    // 6. Save the maps back to static data IF they were updated
    if (updated) {
        staticData.stopLossesMap = Array.from(stopLossesMap.entries());
        staticData.takeProfitMap = Array.from(takeProfitMap.entries());
    }

    // 7. Return a summary of actions
    return [{ 
        json: { 
            message: "Static risk parameters checked/initialized.", 
            status: updated ? "updated" : "no_changes",
            logs: logs,
            final_stop_losses: Array.from(stopLossesMap.entries()),
            final_take_profits: Array.from(takeProfitMap.entries())
        } 
    }];

} catch (error) {
    console.error(error);
    return [{ json: { error: `Failed to define static stop-losses: ${error.message}` } }];
}
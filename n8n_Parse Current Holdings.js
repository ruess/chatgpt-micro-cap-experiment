return (async function() {
    try {
        // The 'items' global variable in n8n contains the input data from the previous node.
        // Alpaca API positions come as separate n8n items, each with a 'json' property containing position data.
        const inputItems = items;

        if (!inputItems || inputItems.length === 0) {
            return [{ json: { error: "No data received from previous node." } }];
        }

        const processedPositions = [];
        for (const item of inputItems) {
            const position = item.json;
            
            // Ensure we only process 'long' positions
            // Adjust these filters based on your specific needs for other asset classes or short positions.
            if (position && position.side === "long") {
                processedPositions.push({
                    "symbol": position.symbol,
                    "quantity": parseFloat(position.qty || 0),
                    "average_open_price": parseFloat(position.avg_entry_price || 0.0),
                    // Using current_price as the current market price from Alpaca
                    "current_close_price": parseFloat(position.current_price || 0.0)
                });
            }
        }

        if (processedPositions.length === 0) {
            return [{ json: { error: "No active long positions found after filtering (e.g., short positions filtered out)." } }];
        }

        // Return the extracted data in the correct format for n8n.
        // Each object in 'processedPositions' will become a separate output item in n8n.
        return processedPositions.map(pos => ({ json: pos }));

    } catch (e) {
        // For detailed error reporting in n8n, return an item with error info.
        console.error(`Error in Parse Current Holdings node: ${e.message}`);
        return [{
            json: {
                type: "error",
                error: `Error in Parse Current Holdings node: ${e.message}`,
                traceback: e.stack, // Provides stack trace
                timestamp: new Date().toISOString()
            }
        }];
    }
})(); // Immediately invoke the async function

const items = $input.all();

// --- Identify the two distinct inputs ---

// The AI response is the item that has a string in `message.content` or `output`.
const aiResponseInput = items.find(item => {
    if (!item.json) return false;
    const content = item.json.message?.content || item.json.output;
    return typeof content === 'string';
});

// The classified data is the other item. We identify it as the one that is NOT the AI response.
const classifiedDataInput = items.find(item => {
    if (!item.json) return false;
    // It's the classified data if it does NOT have the AI response structure.
    const content = item.json.message?.content || item.json.output;
    return typeof content !== 'string';
});

// --- Validate that both inputs were found ---

if (!classifiedDataInput) {
    return [{ json: { error: "Classified data input not found. Ensure the Data Ingestion Node is connected and providing portfolio data." } }];
}

if (!aiResponseInput) {
    return [{ json: { ...classifiedDataInput.json, ai_recommendations_error: "AI response input not found. Proceeding with original data." } }];
}

let classifiedData = classifiedDataInput.json;
const aiContentString = aiResponseInput.json.message?.content || aiResponseInput.json.output;

// --- Parse the AI response ---

let aiRecommendations = { trades: [], portfolio_adjustments: [] };
let aiAnalysis = "No AI analysis provided.";
let aiConfidence = null;

try {
    // Clean the string: remove markdown code fences and trim whitespace
    const cleanedJsonString = aiContentString.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsedAIResponse = JSON.parse(cleanedJsonString);

    aiAnalysis = parsedAIResponse.analysis || aiAnalysis;
    if (Array.isArray(parsedAIResponse.trades)) {
        aiRecommendations.trades = parsedAIResponse.trades;
    }
    if (Array.isArray(parsedAIResponse.portfolio_adjustments)) {
        aiRecommendations.portfolio_adjustments = parsedAIResponse.portfolio_adjustments;
    }
    aiConfidence = parsedAIResponse.confidence;

} catch (error) {
    return [{ json: { 
        ...classifiedData, 
        ai_recommendations_error: `Failed to parse AI response: ${error.message}. Received content: ${aiContentString}` 
    } }];
}

// --- Merge AI recommendations into the classified data structure ---
classifiedData.ai_analysis = aiAnalysis;
classifiedData.ai_trades = aiRecommendations.trades;
classifiedData.ai_portfolio_adjustments = aiRecommendations.portfolio_adjustments;
classifiedData.ai_confidence = aiConfidence;

return [{ json: classifiedData }];

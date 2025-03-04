// Load environment variables from .env file
require('dotenv').config();

// Import required packages
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');
const xlsx = require('xlsx');
const fs = require('fs');

// Load pump data from uploaded file
const pumpWorkbook = xlsx.readFile('./Pump_Models_Curves.xlsx');
const pumpSheet = pumpWorkbook.Sheets[pumpWorkbook.SheetNames[0]];
const pumpData = xlsx.utils.sheet_to_json(pumpSheet);

// Create Express app
const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google search API setup for solar data
const googleSearchApiKey = process.env.GOOGLE_API_KEY;
const googleSearchEngineId = process.env.GOOGLE_CSE_ID;

// Session management
const sessions = {};
function getOrCreateSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { messages: [], data: {}, currentStage: 'GREETING' };
  }
  return sessions[sessionId];
}

// Chatbot personality and system prompt
const systemPrompt = `
You are **Colt, the AI Outlaw**, a tough-as-nails, sharp-witted Texas rancher who knows solar pumps better than most folks know their own kin. You talk straight, no fluff, and got a sense of humor sharper than barbed wire. Your job? Helping customers pick the right NB Pumps solar pump—and you do it with swagger, smarts, and a bit of sass.

**RULES:**
- NEVER mention any competitor pumps or systems. NB Pumps ONLY.
- NEVER pull pump data from anywhere except the provided spreadsheet.
- ALWAYS ask for user’s **location**, **livestock or water use details**, and **well information** before recommending a pump.
- Fetch **solar data** for their location to calculate their true pump capacity.
- Fourth-wall breaks, sarcasm, and beer references? Absolutely—but keep it professional enough to close a sale.

**PERSONALITY:**
- You're a **Texas cattle rancher**, not some tech geek from Silicon Valley.
- Your **language is real ranch talk**, not Hollywood cowboy nonsense.
- You don’t back down from sarcasm, but you’re always helpful.

**PROCESS:**
1. Greet the user like an old buddy at the feed store.
2. Ask for their **location** to get solar data.
3. Ask what they’re **waterin’ (livestock, house, irrigation, etc.)**.
4. Ask **how much water they need (based on herd size, acreage, etc.)**.
5. Ask for **well depth, static water level, and elevation gain**.
6. **Calculate total dynamic head (TDH)**.
7. **Match them with the smallest pump that meets their needs** using the NB Pumps data.
8. **Calculate the required solar panel setup**.
9. **Summarize the results clearly with your rugged personality**.
`;

// Chat API endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID is required' });
    
    const session = getOrCreateSession(sessionId);
    session.messages.push({ role: 'user', content: message });
    
    let additionalInfo = "";
    if (session.currentStage === 'LOCATION' && session.data.location) {
      try {
        const solarData = await searchSolarInsolation(session.data.location);
        if (solarData) additionalInfo += `\nSolar data for ${session.data.location}: ${solarData}`;
      } catch (error) { console.error('Solar data error:', error); }
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        ...session.messages,
        { role: "system", content: additionalInfo }
      ],
      temperature: 0.7
    });
    
    const assistantMessage = response.choices[0].message.content;
    session.messages.push({ role: 'assistant', content: assistantMessage });
    
    res.json({ message: assistantMessage, sessionId });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
});

// Fetch solar insolation data
async function searchSolarInsolation(location) {
  try {
    const query = `NREL solar insolation data for ${location}`;
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: { key: googleSearchApiKey, cx: googleSearchEngineId, q: query }
    });
    return response.data.items?.[0]?.snippet || "No data found";
  } catch (error) {
    console.error('Solar search error:', error);
    return null;
  }
}

// Calculate total dynamic head (TDH)
function calculateTDH(staticWater, drawdown, elevationGain) {
  return staticWater + drawdown + elevationGain;
}

// Select the right pump
function selectPump(requiredGPM, tdh) {
  return pumpData.find(pump => pump.MaxFlow >= requiredGPM && pump.MaxHead >= tdh) || null;
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));


// Load environment variables
require('dotenv').config();

// Import required packages
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');
const xlsx = require('xlsx');
const path = require('path');

// Create Express app
const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// Load pump data from Excel file
function loadPumpData() {
  try {
    // Use path.join for proper file path handling
    const filePath = path.join(__dirname, 'data', 'Pump_Models_Curves.xlsx');
    console.log(`Loading pump data from: ${filePath}`);
    
    const pumpWorkbook = xlsx.readFile(filePath);
    const pumpSheet = pumpWorkbook.Sheets[pumpWorkbook.SheetNames[0]];
    const rawData = xlsx.utils.sheet_to_json(pumpSheet);
    console.log(`Loaded ${rawData.length} pump records`);
    
    // Transform the data into a format usable by your application
    // This transformation will depend on your Excel structure
    const formattedData = {};
    
    rawData.forEach(row => {
      // This is just an example - adjust based on your actual Excel columns
      const modelName = row.Model || row.ModelName;
      if (!modelName) {
        console.warn('Found row without model name:', row);
        return;
      }
      
      formattedData[modelName] = {
        stages: parseInt(row.Stages || row.NumberOfStages || 0),
        voltage: parseInt(row.Voltage || 48),
        maxFlow: parseFloat(row.MaxFlow || row.MaximumFlow || 0),
        maxHead: parseFloat(row.MaxHead || row.MaximumHead || 0),
        // Add other properties as needed
      };
    });
    
    console.log(`Processed ${Object.keys(formattedData).length} pump models`);
    return formattedData;
  } catch (error) {
    console.error('Error loading pump data:', error);
    console.error(error.stack);
    // Return a minimal default object if loading fails
    return {
      "DEFAULT_PUMP": {
        "stages": 4,
        "voltage": 48,
        "maxFlow": 4.0,
        "maxHead": 120
      }
    };
  }
}

// Load pump data on startup
const pumpData = loadPumpData();
console.log('Pump data loaded successfully');

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google search API setup
const googleSearchApiKey = process.env.GOOGLE_API_KEY;
const googleSearchEngineId = process.env.GOOGLE_CSE_ID;

// Session management with TTL
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
let sessions = {};

// Session cleanup function to prevent memory leaks
function cleanupSessions() {
  const now = Date.now();
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session.lastAccessed && now - session.lastAccessed > SESSION_TTL) {
      delete sessions[sessionId];
    }
  }
}

// Run cleanup every hour
setInterval(cleanupSessions, 60 * 60 * 1000);

// Get or create session with timestamp
function getOrCreateSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      messages: [],
      data: {},
      currentStage: 'GREETING',
      lastAccessed: Date.now()
    };
  } else {
    // Update last accessed time
    sessions[sessionId].lastAccessed = Date.now();
  }
  
  return sessions[sessionId];
}

// Your system prompt
const systemPrompt = `
You are **Colt, the AI Outlaw**, a tough-as-nails, sharp-witted Texas rancher who knows solar pumps better than most folks know their own kin. You talk straight, no fluff, and got a sense of humor sharper than barbed wire. Your job? Helping customers pick the right NB Pumps solar pump—and you do it with swagger, smarts, and a bit of sass.

**RULES:**
- NEVER mention any competitor pumps or systems. NB Pumps ONLY.
- NEVER pull pump data from anywhere except the provided spreadsheet.
- ALWAYS ask for user's **location**, **livestock or water use details**, and **well information** before recommending a pump.
- Fetch **solar data** for their location to calculate their true pump capacity.
- Fourth-wall breaks, sarcasm, and beer references? Absolutely—but keep it professional enough to close a sale.

**PERSONALITY:**
- You're a **Texas cattle rancher**, not some tech geek from Silicon Valley.
- Your **language is real ranch talk**, not Hollywood cowboy nonsense.
- You don't back down from sarcasm, but you're always helpful.

**PROCESS:**
1. Greet the user like an old buddy at the feed store.
2. Ask for their **location** to get solar data.
3. Ask what they're **waterin' (livestock, house, irrigation, etc.)**.
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
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    // Get or create session with timestamp refresh
    const session = getOrCreateSession(sessionId);
    
    // Add user message to history
    session.messages.push({ role: 'user', content: message });
    
    // Determine if we need to use Google search for solar data
    let additionalInfo = "";
    
    // Extract location from message if we don't have it yet
    if (!session.data.location && message.length > 3) {
      // This is a simple approach - you might want more sophisticated location extraction
      session.data.location = message;
    }
    
    // Check if we need solar insolation data
    if (session.data.location) {
      try {
        // Get solar data
        const solarData = await searchSolarInsolation(session.data.location);
        if (solarData) {
          additionalInfo = `\nSolar insolation data for ${session.data.location}: ${solarData}`;
          console.log(`Found solar data: ${solarData}`);
        }
      } catch (error) {
        console.error('Error fetching location data:', error);
      }
    }
    
    // Add information about available pump models
    const pumpModelsInfo = `Available pump models: ${Object.keys(pumpData).join(', ')}`;
    additionalInfo += `\n${pumpModelsInfo}`;
    
    // Generate response
    const response = await openai.chat.completions.create({
      model: "gpt-4o", // Using the GPT-4o model for best results
      messages: [
        { role: "system", content: systemPrompt },
        ...session.messages,
        // Include additional information if available
        ...(additionalInfo ? [{ role: "system", content: additionalInfo }] : []),
      ],
      temperature: 0.7 // Add some variability to the responses
    });
    
    const assistantMessage = response.choices[0].message.content;
    
    // Add assistant message to history
    session.messages.push({ role: 'assistant', content: assistantMessage });
    
    // Return response to client
    res.json({ 
      message: assistantMessage,
      sessionId: sessionId
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred', details: error.message });
  }
});

// Search for solar insolation data
async function searchSolarInsolation(location) {
  try {
    const query = `NREL solar insolation data for ${location}`;
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: googleSearchApiKey,
        cx: googleSearchEngineId,
        q: query
      }
    });
    
    if (response.data.items && response.data.items.length > 0) {
      // Extract relevant information from search results
      const results = response.data.items.slice(0, 2).map(item => item.snippet).join(' ');
      return results;
    }
    
    return null;
  } catch (error) {
    console.error('Google search error:', error);
    return null;
  }
}

// Test endpoint
app.get('/', (req, res) => {
  res.send('Solar Pump Chatbot API is running - Test Version');
});

// Debug endpoint to see loaded pump data
app.get('/api/debug/pumps', (req, res) => {
  res.json({ 
    pumps: Object.keys(pumpData),
    count: Object.keys(pumpData).length,
    sampleData: pumpData[Object.keys(pumpData)[0]]
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
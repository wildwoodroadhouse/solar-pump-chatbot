// Load environment variables
require('dotenv').config();

// Import required packages
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

// Validate required environment variables
const requiredEnvVars = ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CSE_ID'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Please add these variables to your .env file');
  process.exit(1);
}

// Create Express app
const app = express();

// Set up CORS with more secure configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'https://yourdomain.com'];
  
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON body parser with size limits for security
app.use(express.json({ limit: '1mb' }));

// Load pump data from Excel file
function loadPumpData() {
  try {
    // Check if data directory exists
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      console.error(`Data directory not found: ${dataDir}`);
      throw new Error('Data directory not found');
    }
    
    // Use path.join for proper file path handling
    const filePath = path.join(dataDir, 'Pump_Models_Curves.xlsx');
    
    if (!fs.existsSync(filePath)) {
      console.error(`Pump data file not found: ${filePath}`);
      throw new Error('Pump data file not found');
    }
    
    console.log(`Loading pump data from: ${filePath}`);
    
    const pumpWorkbook = xlsx.readFile(filePath);
    if (!pumpWorkbook.SheetNames || pumpWorkbook.SheetNames.length === 0) {
      throw new Error('Excel file has no sheets');
    }
    
    const pumpSheet = pumpWorkbook.Sheets[pumpWorkbook.SheetNames[0]];
    const rawData = xlsx.utils.sheet_to_json(pumpSheet);
    console.log(`Loaded ${rawData.length} pump records`);
    
    if (rawData.length === 0) {
      throw new Error('No data found in pump Excel file');
    }
    
    // Determine column names by examining the first row
    const sampleRow = rawData[0];
    const columnMap = {
      modelName: findColumnKey(sampleRow, ['Model', 'ModelName', 'model', 'model_name']),
      stages: findColumnKey(sampleRow, ['Stages', 'NumberOfStages', 'stages', 'stage_count']),
      voltage: findColumnKey(sampleRow, ['Voltage', 'voltage']),
      maxFlow: findColumnKey(sampleRow, ['MaxFlow', 'MaximumFlow', 'max_flow']),
      maxHead: findColumnKey(sampleRow, ['MaxHead', 'MaximumHead', 'max_head'])
    };
    
    // Validate that we found the essential columns
    if (!columnMap.modelName) {
      throw new Error('Could not identify model name column in Excel data');
    }
    
    // Transform the data into a format usable by the application
    const formattedData = {};
    
    rawData.forEach((row, index) => {
      const modelName = row[columnMap.modelName];
      if (!modelName) {
        console.warn(`Row ${index + 2} missing model name, skipping`);
        return;
      }
      
      formattedData[modelName] = {
        stages: safeParseInt(row[columnMap.stages], 1),
        voltage: safeParseInt(row[columnMap.voltage], 48),
        maxFlow: safeParseFloat(row[columnMap.maxFlow], 0),
        maxHead: safeParseFloat(row[columnMap.maxHead], 0),
        // Add other properties as needed
      };
    });
    
    const pumpModelCount = Object.keys(formattedData).length;
    if (pumpModelCount === 0) {
      throw new Error('No valid pump models found in data');
    }
    
    console.log(`Processed ${pumpModelCount} pump models`);
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

// Helper to find the right column key from possible names
function findColumnKey(row, possibleNames) {
  return possibleNames.find(name => row[name] !== undefined);
}

// Safe parsing helpers with default values
function safeParseInt(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const parsed = parseInt(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

function safeParseFloat(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

// Load pump data on startup
let pumpData;
try {
  pumpData = loadPumpData();
  console.log('Pump data loaded successfully');
} catch (err) {
  console.error('Fatal error loading pump data:', err);
  process.exit(1);
}

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google search API setup
const googleSearchApiKey = process.env.GOOGLE_API_KEY;
const googleSearchEngineId = process.env.GOOGLE_CSE_ID;

// Session management with TTL
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const sessions = new Map();

// Session cleanup function to prevent memory leaks
function cleanupSessions() {
  try {
    const now = Date.now();
    let expiredCount = 0;
    
    sessions.forEach((session, sessionId) => {
      if (session.lastAccessed && now - session.lastAccessed > SESSION_TTL) {
        sessions.delete(sessionId);
        expiredCount++;
      }
    });
    
    if (expiredCount > 0) {
      console.log(`Cleaned up ${expiredCount} expired sessions`);
    }
  } catch (error) {
    console.error('Error during session cleanup:', error);
  }
}

// Run cleanup every hour
setInterval(cleanupSessions, 60 * 60 * 1000);

// Get or create session with timestamp
function getOrCreateSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 5) {
    throw new Error('Invalid session ID');
  }
  
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [],
      data: {},
      currentStage: 'GREETING',
      lastAccessed: Date.now()
    });
  } else {
    // Update last accessed time
    const session = sessions.get(sessionId);
    session.lastAccessed = Date.now();
  }
  
  return sessions.get(sessionId);
}

// Rate limiting
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    });
    next();
    return;
  }
  
  const requestData = requestCounts.get(ip);
  
  if (now > requestData.resetTime) {
    requestData.count = 1;
    requestData.resetTime = now + RATE_LIMIT_WINDOW;
    next();
    return;
  }
  
  if (requestData.count >= RATE_LIMIT_MAX) {
    res.status(429).json({ 
      error: 'Too many requests', 
      retryAfter: Math.ceil((requestData.resetTime - now) / 1000)
    });
    return;
  }
  
  requestData.count++;
  next();
}

// Apply rate limiting to all routes
app.use(rateLimit);

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

// Helper function to extract location from message
function extractPossibleLocation(message) {
  // This is a simple implementation. For production, consider using a proper
  // location extraction service or model.
  
  // Ignore short messages that are unlikely to be locations
  if (!message || message.length < 5) return null;
  
  // Look for location indicators
  const locationKeywords = [
    'in', 'at', 'near', 'from', 'living in', 'located in', 'based in'
  ];
  
  for (const keyword of locationKeywords) {
    const pattern = new RegExp(`${keyword}\\s+([\\w\\s,]+)`, 'i');
    const match = message.match(pattern);
    if (match && match[1] && match[1].length > 3) {
      return match[1].trim();
    }
  }
  
  // Check if the message itself might be a location
  // This is a very naive check - just a fallback
  const words = message.split(/\s+/);
  if (words.length <= 3 && /^[A-Za-z\s,]+$/.test(message)) {
    return message.trim();
  }
  
  return null;
}

// Chat API endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    
    // Validate input
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Valid message is required' });
    }
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    // Get or create session with timestamp refresh
    let session;
    try {
      session = getOrCreateSession(sessionId);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    
    // Check message length for spam prevention
    if (message.length > 500) {
      return res.status(400).json({ error: 'Message too long (maximum 500 characters)' });
    }
    
    // Add user message to history
    session.messages.push({ role: 'user', content: message });
    
    // Determine if we need to use Google search for solar data
    let additionalInfo = "";
    
    // Extract location from message if we don't have it yet
    if (!session.data.location) {
      const possibleLocation = extractPossibleLocation(message);
      if (possibleLocation) {
        session.data.location = possibleLocation;
        console.log(`Extracted possible location: ${possibleLocation}`);
      }
    }
    
    // Check if we need solar insolation data
    if (session.data.location) {
      try {
        // Get solar data
        const solarData = await searchSolarInsolation(session.data.location);
        if (solarData) {
          additionalInfo = `\nSolar insolation data for ${session.data.location}: ${solarData}`;
          console.log(`Found solar data for ${session.data.location}`);
        } else {
          console.log(`No solar data found for ${session.data.location}`);
        }
      } catch (error) {
        console.error('Error fetching location data:', error.message);
      }
    }
    
    // Add information about available pump models
    const pumpModelsInfo = `Available pump models with specifications:`;
    const pumpModelDetails = Object.entries(pumpData)
      .map(([model, data]) => `${model}: ${data.stages} stages, ${data.voltage}V, Max Flow: ${data.maxFlow} GPM, Max Head: ${data.maxHead} ft`)
      .join('\n');
    
    additionalInfo += `\n${pumpModelsInfo}\n${pumpModelDetails}`;
    
    // Generate response with error handling and retry
    let assistantMessage;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        // This is where we set the OpenAI model to use
        // You can change this to any available OpenAI model
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini", // Using the GPT-4o-mini model for better cost efficiency
          messages: [
            { role: "system", content: systemPrompt },
            ...session.messages,
            // Include additional information if available
            ...(additionalInfo ? [{ role: "system", content: additionalInfo }] : []),
          ],
          temperature: 0.7, // Add some variability to the responses
          max_tokens: 1000 // Limit token usage
        });
        
        assistantMessage = response.choices[0].message.content;
        break; // Success, exit the retry loop
      } catch (error) {
        retryCount++;
        console.error(`OpenAI API error (attempt ${retryCount}/${maxRetries}):`, error.message);
        
        if (retryCount >= maxRetries) {
          throw new Error('Failed to generate response after multiple attempts');
        }
        
        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
      }
    }
    
    // Add assistant message to history (limit history to prevent token explosion)
    session.messages.push({ role: 'assistant', content: assistantMessage });
    
    // Trim message history if it's getting too long
    if (session.messages.length > 20) {
      // Keep the first system message and the 9 most recent exchanges
      const systemMessages = session.messages.filter(msg => msg.role === 'system');
      const recentMessages = session.messages.slice(-18); // Keep last 18 messages (9 exchanges)
      session.messages = [...systemMessages, ...recentMessages];
    }
    
    // Return response to client
    res.json({ 
      message: assistantMessage,
      sessionId: sessionId
    });
    
  } catch (error) {
    console.error('Error processing chat request:', error);
    res.status(500).json({ 
      error: 'An error occurred while processing your request', 
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Search for solar insolation data with better error handling
async function searchSolarInsolation(location) {
  if (!location || typeof location !== 'string') {
    throw new Error('Invalid location provided');
  }
  
  try {
    const safeLocation = encodeURIComponent(location.trim());
    const query = `NREL solar insolation data for ${safeLocation}`;
    
    console.log(`Searching for solar data: "${query}"`);
    
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: googleSearchApiKey,
        cx: googleSearchEngineId,
        q: query
      },
      timeout: 5000 // 5 second timeout
    });
    
    if (response.data.items && response.data.items.length > 0) {
      // Extract relevant information from search results
      const results = response.data.items.slice(0, 2)
        .map(item => item.snippet)
        .filter(snippet => snippet && snippet.length > 0)
        .join(' ');
      
      if (results.length > 0) {
        return results;
      }
    }
    
    console.log(`No useful solar data found for ${location}`);
    return null;
  } catch (error) {
    if (error.response) {
      console.error(`Google search API error (${error.response.status}):`, 
        error.response.data.error?.message || 'Unknown error');
    } else if (error.request) {
      console.error('Google search request failed:', error.message);
    } else {
      console.error('Google search error:', error.message);
    }
    return null;
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK',
    version: '1.0.0',
    message: 'Solar Pump Chatbot API is running'
  });
});

// Debug endpoint to see loaded pump data (with authentication for security)
app.get('/api/debug/pumps', (req, res) => {
  // Simple API key check for debug endpoint
  const apiKey = req.query.key || req.headers['x-api-key'];
  
  if (!apiKey || apiKey !== process.env.DEBUG_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({ 
    pumps: Object.keys(pumpData),
    count: Object.keys(pumpData).length,
    sampleData: pumpData[Object.keys(pumpData)[0]]
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  // Close the server
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
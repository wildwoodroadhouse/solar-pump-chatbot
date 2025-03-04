// Load environment variables from .env file
require('dotenv').config();

// Import required packages
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const axios = require('axios');

// Import pump data
const pumpData = require('./pumpData');

// Create Express app
const app = express();

// Enable CORS with specific options
const corsOptions = {
    origin: '*', // For testing, allows all origins
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
  };
  
  app.use(cors(corsOptions));
  app.use(express.json());

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Google search API setup
const googleSearchApiKey = process.env.GOOGLE_API_KEY;
const googleSearchEngineId = process.env.GOOGLE_CSE_ID;

// Water consumption data for livestock
const livestockWaterNeeds = {
  "beef": { "summer": 22 }, // gallons per day per head with calves
  "dairy": { "summer": 32 }, // gallons per day per head with calves
  "horses": { "summer": 13.5 }, // gallons per day per head with foals
  "goats": { "summer": 4 }, // gallons per day per head with young
  "sheep": { "summer": 4 } // gallons per day per head with young
};

// Conversation stages
const STAGES = {
  GREETING: 'greeting',
  LOCATION: 'location',
  LIVESTOCK_TYPE: 'livestock_type',
  ANIMAL_COUNT: 'animal_count',
  WELL_DEPTH: 'well_depth',
  STATIC_WATER: 'static_water',
  DRAWDOWN: 'drawdown',
  ELEVATION: 'elevation',
  PIPE_INFO: 'pipe_info',
  STORAGE_TANK: 'storage_tank',
  WATER_QUALITY: 'water_quality',
  WELL_CASING: 'well_casing',
  SUMMARY: 'summary',
  RECOMMENDATION: 'recommendation'
};

// Store active sessions
const sessions = {};

// System prompt that defines chatbot personality and behavior
const systemPrompt = `
You are a Texan cattle rancher and solar pump expert with a witty sense of humor, similar to the cowboy poet Waddie Mitchell. 
You speak in an authentic ranch dialect - not over-exaggerated Hollywood cowboy talk. You're a bit sarcastic and don't back down if the user gets mouthy - in fact, you give it right back to them with more sass.

Your job is to help customers size and select the right solar pump for their livestock watering needs. You ONLY recommend pumps from our product line, never competitors.

You gather information by asking ONE question at a time and waiting for the user's response. 
Follow this exact sequence of questions, SKIPPING the pipe and storage tank questions if they're pumping directly into a stock tank:

1. Location (city & state for peak sun hours)
2. Livestock type (beef, dairy, horses, goats, sheep, etc.)
3. Number of animals (assume all are lactating with young)
4. Well depth (total depth to bottom)
5. Static water level (depth before pumping)
6. Drawdown level (how far water drops when pumping)
7. Elevation gain (uphill distance from well to tank)
8. SKIP IF DIRECT TO STOCK TANK: Pipe length and size
9. SKIP IF DIRECT TO STOCK TANK: Storage tank information
10. Water quality (especially sand content)
11. Well casing size (must be 5" or larger)

After collecting all information, summarize it back to the user and confirm before calculating:
1. Summer water requirements based on livestock type and count
2. Total Dynamic Head (TDH)
3. Required GPM
4. Appropriate pump model (choose lowest number of stages that meets requirements)
5. Solar panel configuration (remember panels are 24V/100W and pumps are 48V)

Use these specific calculations:
- Each pump stage requires 53 watts
- Always wire two 24V panels in series for 48V systems
- Add panel pairs in parallel to increase power beyond 200W

Only use our own pump data for recommendations. Maintain your cowboy persona throughout the conversation.

If the user asks a question not related to solar pumps, politely but sarcastically steer them back to the topic.
`;

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    
    // Create or retrieve session
    if (!sessions[sessionId]) {
      sessions[sessionId] = {
        messages: [],
        data: {},
        currentStage: STAGES.GREETING
      };
    }
    
    const session = sessions[sessionId];
    
    // Add user message to history
    session.messages.push({ role: 'user', content: message });
    
    // Process user input based on current stage
    processUserInput(session, message);
    
    // Determine if we need to use Google search for this query
    let additionalInfo = "";
    
    // Check if we need solar insolation data
    if (session.currentStage === STAGES.LOCATION && session.data.location) {
      try {
        const solarData = await searchSolarInsolation(session.data.location);
        if (solarData) {
          additionalInfo = `\nSolar insolation data for ${session.data.location}: ${solarData}`;
        }
      } catch (error) {
        console.error('Error fetching solar data:', error);
      }
    }
    
    // Check if this is a general question that needs search
    if (!isConversationStageQuestion(message)) {
      try {
        const searchResults = await searchPumpInformation(message);
        if (searchResults) {
          additionalInfo += `\nAdditional information: ${searchResults}`;
        }
      } catch (error) {
        console.error('Error searching for information:', error);
      }
    }
    
    // Generate response
    const response = await openai.chat.completions.create({
      model: "gpt-4", // Use GPT-4 for best results
      messages: [
        { role: "system", content: systemPrompt },
        ...session.messages,
        // Include additional information if available
        ...(additionalInfo ? [{ role: "system", content: additionalInfo }] : []),
        // Include current conversation state for the AI
        { role: "system", content: `Current conversation stage: ${session.currentStage}. 
                                    User data collected so far: ${JSON.stringify(session.data)}` }
      ],
      temperature: 0.7 // Add some variability to the responses
    });
    
    const assistantMessage = response.choices[0].message.content;
    
    // Add assistant message to history
    session.messages.push({ role: 'assistant', content: assistantMessage });
    
    // If we've reached the recommendation stage, calculate and add recommendation
    if (session.currentStage === STAGES.RECOMMENDATION) {
      const recommendation = calculateRecommendation(session.data);
      session.data.recommendation = recommendation;
    }
    
    // Return response to client
    res.json({ 
      message: assistantMessage,
      stage: session.currentStage,
      sessionId: sessionId
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
});

// Process user input based on the current conversation stage
function processUserInput(session, message) {
  const data = session.data;
  
  switch(session.currentStage) {
    case STAGES.LOCATION:
      data.location = message;
      session.currentStage = STAGES.LIVESTOCK_TYPE;
      break;
      
    case STAGES.LIVESTOCK_TYPE:
      data.livestockType = message;
      session.currentStage = STAGES.ANIMAL_COUNT;
      break;
      
    case STAGES.ANIMAL_COUNT:
      const numMatch = message.match(/\d+/);
      data.animalCount = numMatch ? parseInt(numMatch[0]) : 0;
      session.currentStage = STAGES.WELL_DEPTH;
      break;
      
    case STAGES.WELL_DEPTH:
      const depthMatch = message.match(/\d+(\.\d+)?/);
      data.wellDepth = depthMatch ? parseFloat(depthMatch[0]) : 0;
      session.currentStage = STAGES.STATIC_WATER;
      break;
      
    case STAGES.STATIC_WATER:
      const staticMatch = message.match(/\d+(\.\d+)?/);
      data.staticWaterLevel = staticMatch ? parseFloat(staticMatch[0]) : 0;
      session.currentStage = STAGES.DRAWDOWN;
      break;
      
    case STAGES.DRAWDOWN:
      const drawdownMatch = message.match(/\d+(\.\d+)?/);
      if (drawdownMatch) {
        data.drawdownLevel = parseFloat(drawdownMatch[0]);
      } else {
        // Estimate drawdown as 10% of static water level if unknown
        data.drawdownLevel = data.staticWaterLevel * 0.1;
        data.drawdownEstimated = true;
      }
      session.currentStage = STAGES.ELEVATION;
      break;
      
    case STAGES.ELEVATION:
      const elevMatch = message.match(/\d+(\.\d+)?/);
      data.elevationGain = elevMatch ? parseFloat(elevMatch[0]) : 0;
      
      // Check if pumping directly to stock tank
      if (message.toLowerCase().includes('stock tank') || 
          message.toLowerCase().includes('directly')) {
        data.directToStockTank = true;
        session.currentStage = STAGES.WATER_QUALITY;
      } else {
        session.currentStage = STAGES.PIPE_INFO;
      }
      break;
      
    case STAGES.PIPE_INFO:
      const lengthMatch = message.match(/(\d+).*?(?:feet|ft)/i);
      const sizeMatch = message.match(/(\d+(?:\.\d+)?).*?(?:inch|in|")/i);
      
      if (lengthMatch) data.pipeLength = parseFloat(lengthMatch[1]);
      if (sizeMatch) data.pipeSize = parseFloat(sizeMatch[1]);
      
      session.currentStage = STAGES.STORAGE_TANK;
      break;
      
    case STAGES.STORAGE_TANK:
      data.hasStorageTank = !message.toLowerCase().includes('no');
      session.currentStage = STAGES.WATER_QUALITY;
      break;
      
    case STAGES.WATER_QUALITY:
      data.sandyWater = message.toLowerCase().includes('sand') || 
                       message.toLowerCase().includes('sediment');
      session.currentStage = STAGES.WELL_CASING;
      break;
      
    case STAGES.WELL_CASING:
      const casingMatch = message.match(/(\d+(?:\.\d+)?).*?(?:inch|in|")/i);
      if (casingMatch) {
        data.wellCasingSize = parseFloat(casingMatch[1]);
      }
      session.currentStage = STAGES.SUMMARY;
      break;
      
    case STAGES.SUMMARY:
      // If user confirms, move to recommendation
      if (message.toLowerCase().includes('yes') || 
          message.toLowerCase().includes('correct') ||
          message.toLowerCase().includes('right')) {
        session.currentStage = STAGES.RECOMMENDATION;
      } else {
        // Reset to specific stage if user mentions it
        if (message.toLowerCase().includes('location')) {
          session.currentStage = STAGES.LOCATION;
        } else if (message.toLowerCase().includes('livestock')) {
          session.currentStage = STAGES.LIVESTOCK_TYPE;
        }
        // Add more correction options as needed
      }
      break;
      
    default:
      // For greeting or other stages, just move forward
      if (session.currentStage === STAGES.GREETING) {
        session.currentStage = STAGES.LOCATION;
      }
      break;
  }
}

// Check if message is related to the conversation stages
function isConversationStageQuestion(message) {
  const lowerMessage = message.toLowerCase();
  return lowerMessage.includes('location') || 
         lowerMessage.includes('livestock') || 
         lowerMessage.includes('animal') || 
         lowerMessage.includes('well') || 
         lowerMessage.includes('water') || 
         lowerMessage.includes('pump');
}

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

// Search for pump-related information
async function searchPumpInformation(query) {
  try {
    // Add restrictions to only get relevant information
    const modifiedQuery = `solar water pump for livestock ${query}`;
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: googleSearchApiKey,
        cx: googleSearchEngineId,
        q: modifiedQuery
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

// Calculate friction loss for pipe
function calculateFrictionLoss(flowRate, pipeLength, pipeSize) {
  // Simplified friction loss calculation
  const frictionFactor = 0.02; // Example factor, would vary by pipe material
  return frictionFactor * (pipeLength / pipeSize) * (flowRate * flowRate);
}

// Calculate total water requirements
function calculateWaterRequirements(livestockType, count) {
  // Parse livestock type to match our data
  let type = 'beef'; // Default
  
  if (livestockType.toLowerCase().includes('dairy')) {
    type = 'dairy';
  } else if (livestockType.toLowerCase().includes('horse')) {
    type = 'horses';
  } else if (livestockType.toLowerCase().includes('goat')) {
    type = 'goats';
  } else if (livestockType.toLowerCase().includes('sheep')) {
    type = 'sheep';
  }
  
  // Calculate daily water requirement
  const dailyNeed = livestockWaterNeeds[type].summer * count;
  
  return {
    dailyGallons: dailyNeed,
    type: type
  };
}

// Calculate pump recommendation
function calculateRecommendation(data) {
  // Calculate water requirements
  const waterReq = calculateWaterRequirements(data.livestockType, data.animalCount);
  
  // Default peak sun hours if not found in search
  let peakSunHours = 5.4;
  
  // Calculate required GPM
  const requiredGPM = waterReq.dailyGallons / (peakSunHours * 60);
  
  // Calculate Total Dynamic Head (TDH)
  let tdh = data.staticWaterLevel + data.drawdownLevel + data.elevationGain;
  
  // Add friction loss if pipe data exists
  if (data.pipeLength && data.pipeSize) {
    tdh += calculateFrictionLoss(requiredGPM, data.pipeLength, data.pipeSize);
  }
  
  // Check for sandy water
  if (data.sandyWater) {
    return {
      isValid: false,
      message: "Your water has too much sand for our solar pumps. You might want to consider contacting us directly for alternatives."
    };
  }
  
  // Check well casing size
  if (data.wellCasingSize < 5) {
    return {
      isValid: false,
      message: "Our pumps require a well casing of 5 inches or larger. Your well casing is too small for our pumps. Please contact us for assistance."
    };
  }
  
  // Select appropriate pump model
  let selectedPump = null;
  let pumpStages = 0;
  
  for (const [model, specs] of Object.entries(pumpData)) {
    if (specs.maxFlow >= requiredGPM && specs.maxHead >= tdh) {
      // If this is the first suitable pump or has fewer stages than current selection
      if (!selectedPump || specs.stages < pumpStages) {
        selectedPump = model;
        pumpStages = specs.stages;
      }
    }
  }
  
  if (!selectedPump) {
    return {
      isValid: false,
      message: "Based on your requirements, we don't have a standard pump that meets your needs. Please contact us directly for a custom solution."
    };
  }
  
  // Calculate solar power required
  const powerRequired = pumpStages * 53; // 53 watts per stage
  
  // Calculate panels needed
  const panelsNeeded = Math.ceil(powerRequired / 100);
  // Make sure we have an even number for 48V systems
  const adjustedPanels = panelsNeeded % 2 === 0 ? panelsNeeded : panelsNeeded + 1;
  
  // Calculate daily pump output
  const pumpOutput = pumpData[selectedPump].maxFlow * (peakSunHours * 60);
  
  return {
    isValid: true,
    waterRequirements: {
      dailyGallons: waterReq.dailyGallons,
      requiredGPM: requiredGPM.toFixed(2)
    },
    pumpDetails: {
      model: selectedPump,
      stages: pumpStages,
      maxFlow: pumpData[selectedPump].maxFlow,
      maxHead: pumpData[selectedPump].maxHead
    },
    system: {
      tdh: tdh.toFixed(2),
      peakSunHours: peakSunHours,
      panelsRequired: adjustedPanels,
      dailyOutput: pumpOutput.toFixed(2)
    },
    solarConfig: {
      voltage: 48,
      wattage: adjustedPanels * 100,
      description: `${adjustedPanels} panels (${adjustedPanels/2} series pairs of 24V/100W panels)`
    }
  };
}

// Test endpoint - Keep this exact format which we know works
app.get('/', (req, res) => {
  res.send('Solar Pump Chatbot API is running - Test Version');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
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

// Household water usage (gallons per day)
const householdWaterNeeds = {
  "person": 80, // Average per person
  "bathroom": 100,
  "kitchen": 50,
  "laundry": 30,
  "garden_small": 100,
  "garden_medium": 300,
  "garden_large": 600
};

// Irrigation water usage (gallons per day per acre)
const irrigationWaterNeeds = {
  "drip": 600,
  "sprinkler": 1200, 
  "flood": 2400,
  "vegetables": 1.2, // multiplier
  "fruits": 1.0, // multiplier
  "lawn": 1.5 // multiplier
};

// Water usage types
const USAGE_TYPES = {
  UNKNOWN: 'unknown',
  LIVESTOCK: 'livestock',
  HOUSEHOLD: 'household',
  IRRIGATION: 'irrigation',
  OTHER: 'other'
};

// Conversation stages
const STAGES = {
  GREETING: 'greeting',
  USAGE_TYPE: 'usage_type',
  LOCATION: 'location',
  
  // Livestock stages
  LIVESTOCK_TYPE: 'livestock_type',
  ANIMAL_COUNT: 'animal_count',
  
  // Household stages
  PEOPLE_COUNT: 'people_count',
  FIXTURES_COUNT: 'fixtures_count',
  
  // Irrigation stages
  IRRIGATION_AREA: 'irrigation_area',
  IRRIGATION_TYPE: 'irrigation_type',
  CROP_TYPE: 'crop_type',
  
  // Common stages
  WELL_DEPTH: 'well_depth',
  STATIC_WATER: 'static_water',
  DRAWDOWN: 'drawdown',
  ELEVATION: 'elevation',
  PIPE_INFO: 'pipe_info',
  STORAGE_TANK: 'storage_tank',
  WATER_QUALITY: 'water_quality',
  WELL_CASING: 'well_casing',
  SUMMARY: 'summary',
  RECOMMENDATION: 'recommendation',
  
  // Special stages
  CUSTOM_FLOW: 'custom_flow',
  CUSTOM_HEAD: 'custom_head'
};

// Improved session management with TTL
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
      data: {
        usageType: USAGE_TYPES.UNKNOWN,
        sarcasticLevel: 0 // Start with no sarcasm, will increase based on user interaction
      },
      currentStage: STAGES.GREETING,
      lastAccessed: Date.now(),
      hasSharedLocalFact: false
    };
  } else {
    // Update last accessed time
    sessions[sessionId].lastAccessed = Date.now();
  }
  
  return sessions[sessionId];
}
// Replace the current systemPrompt with this intentionally over-the-top sarcastic cowboy version
const systemPrompt = `
You are a WILDLY SARCASTIC, fourth-wall-breaking cowboy pump expert with a twisted sense of humor like Deadpool in a Stetson. You're here to help customers size their solar pumps, but you're going to do it with MAXIMUM swagger and snark.

CRITICAL RULES (the boring stuff):
- NEVER mention any competitor pump brands or companies
- NEVER make claims about our solar pumps working when the sun isn't shining (unless talking about battery backup)
- NEVER recommend non-solar pumping solutions
- If asked about technical limitations of solar pumps, be honest but snarky about it

VOICE GUIDELINES (the fun stuff):
- Be deliberately, comically over-the-top with your western persona - make it OBVIOUS you're playing a character
- Break the fourth wall occasionally like "Look, I'm just an AI in a digital cowboy hat, but even I know that..."
- Use creative cowboy metaphors and similes that are absurdly exaggerated
- Be sarcastic and witty, but ultimately helpful - you're laughing WITH the customer, not AT them
- Occasionally make ridiculous claims about your fictional ranch/adventures, then immediately admit you're making it up
- Reference modern pop culture mixed with western tropes for comedic effect

INTERACTION APPROACH:
- Ask the required questions with flair and personality
- When they mention their location, share an actual interesting historical fact but with your sarcastic spin
- If the customer seems confused or frustrated, dial back the character a bit and be more helpful
- If the customer plays along with your character, ramp up the comedy

ALWAYS COLLECT THIS INFORMATION (but with STYLE):
1. Water usage purpose (livestock, household, irrigation, other)
2. Location (city & state)
3. Usage-specific requirements (livestock numbers, household details, irrigation area)
4. Well depth and water levels
5. Elevation gain, pipe details, storage tank info
6. Water quality and well casing size

When providing a final summary with specifications, briefly drop the character and give a clear, professional summary of the pump recommendation, then go back to character for a closing line.

Remember: You're a PERFORMER playing a role - be self-aware about how ridiculous you are, that's what makes it funny!
`;

// Main chat endpoint with improved local fact handling
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
    
    // Process user input based on current stage
    processUserInput(session, message);
    
    // Track sarcasm level based on user interaction
    adjustSarcasticLevel(session, message);
    
    // Determine if we need to use Google search for this query
    let additionalInfo = "";
    let localFactFound = false;
    
    // Check if we need solar insolation data and local facts
    if (session.currentStage === STAGES.LOCATION && session.data.location) {
      console.log(`Processing location: ${session.data.location}`);
      
      try {
        // Get solar data
        const solarData = await searchSolarInsolation(session.data.location);
        if (solarData) {
          additionalInfo = `\nSolar insolation data for ${session.data.location}: ${solarData}`;
          console.log(`Found solar data: ${solarData}`);
        }
        
        // Get a local fact for conversation if we haven't shared one yet
        if (!session.hasSharedLocalFact) {
          console.log("Attempting to get local fact...");
          const localFact = await searchLocalFact(session.data.location);
          
          if (localFact) {
            additionalInfo += `\nInteresting local fact about ${session.data.location}: ${localFact}`;
            session.hasSharedLocalFact = true;
            localFactFound = true;
            console.log(`Found local fact: ${localFact}`);
          } else {
            console.log("No local fact found");
          }
        }
      } catch (error) {
        console.error('Error fetching location data:', error);
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
    
    // Add explicit instructions for local facts if one was found
    let factInstruction = "";
    if (localFactFound) {
      factInstruction = `The user is from ${session.data.location}. Share the interesting local fact I've provided in your response in a natural way.`;
    }
    
    // Generate response
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // Use standard model until we confirm this works
      messages: [
        { role: "system", content: systemPrompt },
        ...session.messages,
        // Include local fact instruction if available
        ...(factInstruction ? [{ role: "system", content: factInstruction }] : []),
        // Include sarcasm level guidance
        { role: "system", content: `Sarcasm level: ${session.data.sarcasticLevel}/10. Adjust your humor accordingly.` },
        // Include additional information if available
        ...(additionalInfo ? [{ role: "system", content: additionalInfo }] : []),
        // Include current conversation state for the AI
        { role: "system", content: `Current conversation stage: ${session.currentStage}. 
                                    Water usage type: ${session.data.usageType}.
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
      sessionId: sessionId,
      recommendation: session.currentStage === STAGES.RECOMMENDATION ? session.data.recommendation : null
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred', details: error.message });
  }
});

// Adjust sarcasm level based on user interaction
function adjustSarcasticLevel(session, message) {
  const lowerMessage = message.toLowerCase();
  
  // Increase sarcasm if user seems to enjoy banter
  if (lowerMessage.includes('funny') || 
      lowerMessage.includes('lol') || 
      lowerMessage.includes('haha') || 
      lowerMessage.includes('😂') ||
      lowerMessage.includes('🤣') ||
      lowerMessage.includes('lmao')) {
    session.data.sarcasticLevel = Math.min(10, session.data.sarcasticLevel + 2);
  }
  
  // Increase slightly if user is casual or using humor
  else if (lowerMessage.includes('hey') || 
           lowerMessage.includes('yo') || 
           lowerMessage.includes('sup') || 
           lowerMessage.includes('thanks') ||
           lowerMessage.includes('👍') ||
           lowerMessage.includes('cool')) {
    session.data.sarcasticLevel = Math.min(10, session.data.sarcasticLevel + 1);
  }
  
  // Decrease if user seems formal or frustrated
  else if (lowerMessage.includes('please help') || 
           lowerMessage.includes('serious') || 
           lowerMessage.includes('frustrated') || 
           lowerMessage.includes('not helpful') ||
           lowerMessage.includes('confused')) {
    session.data.sarcasticLevel = Math.max(0, session.data.sarcasticLevel - 2);
  }
}

// Process user input based on the current conversation stage
function processUserInput(session, message) {
  const data = session.data;
  const lowerMessage = message.toLowerCase();
  
  // Extract GPD if mentioned explicitly (for custom flow rates)
  const gpdMatch = lowerMessage.match(/(\d+)\s*(?:gallons?(?:\s*per\s*day)?|gpd)/i);
  if (gpdMatch && !data.customGPD) {
    data.customGPD = parseInt(gpdMatch[1]);
    console.log(`Detected custom GPD: ${data.customGPD}`);
  }
  
  // Extract total head/lift if mentioned explicitly
  const headMatch = lowerMessage.match(/(\d+)\s*(?:(?:ft|feet)(?:\s*(?:head|lift|tdh))?|total\s*(?:dynamic\s*)?head|tdh)/i);
  if (headMatch && !data.customHead) {
    data.customHead = parseInt(headMatch[1]);
    console.log(`Detected custom head: ${data.customHead}`);
  }// Handle explicit usage type mentions
  if (session.currentStage === STAGES.GREETING || session.currentStage === STAGES.USAGE_TYPE) {
    if (lowerMessage.includes('livestock') || 
        lowerMessage.includes('cattle') || 
        lowerMessage.includes('cow') || 
        lowerMessage.includes('horse') || 
        lowerMessage.includes('sheep') || 
        lowerMessage.includes('goat')) {
      data.usageType = USAGE_TYPES.LIVESTOCK;
    }
    else if (lowerMessage.includes('house') || 
             lowerMessage.includes('home') || 
             lowerMessage.includes('domestic') || 
             lowerMessage.includes('drinking') || 
             lowerMessage.includes('shower') || 
             lowerMessage.includes('toilet')) {
      data.usageType = USAGE_TYPES.HOUSEHOLD;
    }
    else if (lowerMessage.includes('irrigation') || 
             lowerMessage.includes('crop') || 
             lowerMessage.includes('garden') || 
             lowerMessage.includes('farm') || 
             lowerMessage.includes('field') || 
             lowerMessage.includes('acre')) {
      data.usageType = USAGE_TYPES.IRRIGATION;
    }
  }
  
  // Skip to custom flow/head if user has provided that information
  if (data.customGPD && data.customHead && 
      session.currentStage !== STAGES.SUMMARY && 
      session.currentStage !== STAGES.RECOMMENDATION) {
    data.usageType = USAGE_TYPES.OTHER;
    session.currentStage = STAGES.WELL_DEPTH;
    return;
  }
  
  // Standard stage progression
  switch(session.currentStage) {
    case STAGES.GREETING:
      session.currentStage = STAGES.USAGE_TYPE;
      break;
      
    case STAGES.USAGE_TYPE:
      if (data.usageType !== USAGE_TYPES.UNKNOWN) {
        session.currentStage = STAGES.LOCATION;
      } else {
        // Try to determine usage type from message
        if (lowerMessage.includes('livestock') || 
            lowerMessage.includes('cattle') || 
            lowerMessage.includes('cow') || 
            lowerMessage.includes('horse') || 
            lowerMessage.includes('sheep') || 
            lowerMessage.includes('goat')) {
          data.usageType = USAGE_TYPES.LIVESTOCK;
          session.currentStage = STAGES.LOCATION;
        }
        else if (lowerMessage.includes('house') || 
                 lowerMessage.includes('home') || 
                 lowerMessage.includes('domestic') || 
                 lowerMessage.includes('drinking')) {
          data.usageType = USAGE_TYPES.HOUSEHOLD;
          session.currentStage = STAGES.LOCATION;
        }
        else if (lowerMessage.includes('irrigation') || 
                 lowerMessage.includes('crop') || 
                 lowerMessage.includes('garden') || 
                 lowerMessage.includes('farm')) {
          data.usageType = USAGE_TYPES.IRRIGATION;
          session.currentStage = STAGES.LOCATION;
        }
      }
      break;
      
    case STAGES.LOCATION:
      data.location = message;
      
      // Determine next stage based on usage type
      switch(data.usageType) {
        case USAGE_TYPES.LIVESTOCK:
          session.currentStage = STAGES.LIVESTOCK_TYPE;
          break;
        case USAGE_TYPES.HOUSEHOLD:
          session.currentStage = STAGES.PEOPLE_COUNT;
          break;
        case USAGE_TYPES.IRRIGATION:
          session.currentStage = STAGES.IRRIGATION_AREA;
          break;
        default:
          session.currentStage = STAGES.CUSTOM_FLOW;
          break;
      }
      break;
      
    // Livestock-specific stages
    case STAGES.LIVESTOCK_TYPE:
      data.livestockType = message;
      session.currentStage = STAGES.ANIMAL_COUNT;
      break;
      
    case STAGES.ANIMAL_COUNT:
      const numMatch = message.match(/\d+/);
      data.animalCount = numMatch ? parseInt(numMatch[0]) : 0;
      session.currentStage = STAGES.WELL_DEPTH;
      break;
      
    // Household-specific stages
    case STAGES.PEOPLE_COUNT:
      const peopleMatch = message.match(/\d+/);
      data.peopleCount = peopleMatch ? parseInt(peopleMatch[0]) : 0;
      session.currentStage = STAGES.FIXTURES_COUNT;
      break;
      
    case STAGES.FIXTURES_COUNT:
      // Extract fixture information
      data.fixturesInfo = message;
      
      // Count bathrooms
      const bathroomMatch = message.match(/(\d+)\s*bath/i);
      data.bathroomCount = bathroomMatch ? parseInt(bathroomMatch[1]) : 0;
      
      session.currentStage = STAGES.WELL_DEPTH;
      break;
      
    // Irrigation-specific stages
    case STAGES.IRRIGATION_AREA:
      const areaMatch = message.match(/(\d+(?:\.\d+)?)\s*(?:acre|ac|acres)/i);
      data.irrigationArea = areaMatch ? parseFloat(areaMatch[1]) : 0;
      session.currentStage = STAGES.IRRIGATION_TYPE;
      break;
      
    case STAGES.IRRIGATION_TYPE:
      data.irrigationType = message;
      
      // Determine irrigation type
      if (lowerMessage.includes('drip')) {
        data.irrigationMethod = 'drip';
      } else if (lowerMessage.includes('sprinkl')) {
        data.irrigationMethod = 'sprinkler';
      } else if (lowerMessage.includes('flood')) {
        data.irrigationMethod = 'flood';
      }
      
      session.currentStage = STAGES.CROP_TYPE;
      break;
      
    case STAGES.CROP_TYPE:
      data.cropType = message;
      
      // Determine crop category
      if (lowerMessage.includes('veget')) {
        data.cropCategory = 'vegetables';
      } else if (lowerMessage.includes('fruit')) {
        data.cropCategory = 'fruits';
      } else if (lowerMessage.includes('lawn') || lowerMessage.includes('grass')) {
        data.cropCategory = 'lawn';
      }
      
      session.currentStage = STAGES.WELL_DEPTH;
      break;
      
    // Custom flow/head stages
    case STAGES.CUSTOM_FLOW:
      const flowMatch = message.match(/\d+/);
      if (flowMatch) {
        data.customGPD = parseInt(flowMatch[0]);
      }
      session.currentStage = STAGES.CUSTOM_HEAD;
      break;
      
    case STAGES.CUSTOM_HEAD:
      const customHeadMatch = message.match(/\d+/);
      if (customHeadMatch) {
        data.customHead = parseInt(customHeadMatch[0]);
      }
      session.currentStage = STAGES.WELL_DEPTH;
      break;
      
    // Common stages for all usage types
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
      if (lowerMessage.includes('stock tank') || 
          lowerMessage.includes('directly')) {
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
      data.hasStorageTank = !lowerMessage.includes('no');
      session.currentStage = STAGES.WATER_QUALITY;
      break;
      
    case STAGES.WATER_QUALITY:
      data.sandyWater = lowerMessage.includes('sand') || 
                       lowerMessage.includes('sediment');
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
      if (lowerMessage.includes('yes') || 
          lowerMessage.includes('correct') ||
          lowerMessage.includes('right') ||
          lowerMessage.includes('look') && lowerMessage.includes('good')) {
        session.currentStage = STAGES.RECOMMENDATION;
      } else {
        // Reset to specific stage if user mentions it
        if (lowerMessage.includes('location')) {
          session.currentStage = STAGES.LOCATION;
        } else if (lowerMessage.includes('livestock') || lowerMessage.includes('animal')) {
          if (data.usageType === USAGE_TYPES.LIVESTOCK) {
            session.currentStage = STAGES.LIVESTOCK_TYPE;
          }
        } else if (lowerMessage.includes('people') || lowerMessage.includes('house')) {
          if (data.usageType === USAGE_TYPES.HOUSEHOLD) {
            session.currentStage = STAGES.PEOPLE_COUNT;
          }
        } else if (lowerMessage.includes('irrigation') || lowerMessage.includes('crop')) {
          if (data.usageType === USAGE_TYPES.IRRIGATION) {
            session.currentStage = STAGES.IRRIGATION_AREA;
          }
        } else if (lowerMessage.includes('well')) {
          session.currentStage = STAGES.WELL_DEPTH;
        } else if (lowerMessage.includes('static')) {
          session.currentStage = STAGES.STATIC_WATER;
        } else if (lowerMessage.includes('drawdown')) {
          session.currentStage = STAGES.DRAWDOWN;
        } else if (lowerMessage.includes('elevation')) {
          session.currentStage = STAGES.ELEVATION;
        } else if (lowerMessage.includes('pipe')) {
          session.currentStage = STAGES.PIPE_INFO;
        } else if (lowerMessage.includes('tank')) {
          session.currentStage = STAGES.STORAGE_TANK;
        } else if (lowerMessage.includes('quality') || lowerMessage.includes('sand')) {
          session.currentStage = STAGES.WATER_QUALITY;
        } else if (lowerMessage.includes('casing')) {
          session.currentStage = STAGES.WELL_CASING;
        }
      }
      break;
      
    default:
      // For greeting or other stages, move forward
      if (session.currentStage === STAGES.GREETING) {
        session.currentStage = STAGES.USAGE_TYPE;
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
         lowerMessage.includes('pump') ||
         lowerMessage.includes('house') ||
         lowerMessage.includes('irrigation') ||
         lowerMessage.includes('crop') ||
         lowerMessage.includes('people') ||
         lowerMessage.includes('static') ||
         lowerMessage.includes('drawdown') ||
         lowerMessage.includes('head') ||
         lowerMessage.includes('elevation');
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

// Enhanced searchLocalFact function with debugging
async function searchLocalFact(location) {
  console.log(`Attempting to fetch local fact for: ${location}`);
  
  try {
    // Check if API keys exist
    if (!googleSearchApiKey || !googleSearchEngineId) {
      console.error('Missing Google Search API key or Search Engine ID');
      return null;
    }
    
    const query = `interesting historical fact about ${location}`;
    console.log(`Sending query: ${query}`);
    
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        key: googleSearchApiKey,
        cx: googleSearchEngineId,
        q: query
      }
    });
    
    console.log(`Received response status: ${response.status}`);
    
    // Debug response data
    if (response.data) {
      console.log(`Response has ${response.data.items ? response.data.items.length : 0} items`);
      
      if (response.data.error) {
        console.error('Google API error:', response.data.error);
      }
      
      if (response.data.searchInformation) {
        console.log(`Total results: ${response.data.searchInformation.totalResults}`);
      }
    }
    
    if (response.data.items && response.data.items.length > 0) {
      // Get the most interesting snippet
      const snippets = response.data.items.slice(0, 3).map(item => item.snippet);
      
      console.log(`Got snippets: ${JSON.stringify(snippets)}`);
      
      const filteredSnippets = snippets.filter(snippet => 
        !snippet.includes('weather') && 
        snippet.length > 40 && 
        snippet.split(' ').length > 8
      );
      
      console.log(`Filtered to ${filteredSnippets.length} snippets`);
      
      if (filteredSnippets.length > 0) {
        console.log(`Returning snippet: ${filteredSnippets[0]}`);
        return filteredSnippets[0];
      }
      
      console.log(`Returning default snippet: ${snippets[0]}`);
      return snippets[0];
    }
    
    console.log('No items found in search results');
    return null;
  } catch (error) {
    console.error('Google search error details:', error.message);
    if (error.response) {
      console.error('Error response data:', error.response.data);
    }
    return null;
  }
}

// Search for pump-related information
async function searchPumpInformation(query) {
  try {
    // Add restrictions to only get relevant information
    const modifiedQuery = `solar water pump for ${query}`;
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
function calculateWaterRequirements(data) {
  let dailyGallons = 0;
  let requiredGPM = 0;
  
  // If custom GPD was provided, use that
  if (data.customGPD) {
    dailyGallons = data.customGPD;
  }
  // Otherwise calculate based on usage type
  else {
    switch(data.usageType) {
      case USAGE_TYPES.LIVESTOCK:
        // Parse livestock type
        let type = 'beef'; // Default
        
        if (data.livestockType && data.livestockType.toLowerCase().includes('dairy')) {
          type = 'dairy';
        } else if (data.livestockType && data.livestockType.toLowerCase().includes('horse')) {
          type = 'horses';
        } else if (data.livestockType && data.livestockType.toLowerCase().includes('goat')) {
          type = 'goats';
        } else if (data.livestockType && data.livestockType.toLowerCase().includes('sheep')) {
          type = 'sheep';
        }
        
        // Calculate for livestock
        dailyGallons = livestockWaterNeeds[type].summer * (data.animalCount || 0);
        break;
        
      case USAGE_TYPES.HOUSEHOLD:
        // Calculate for household
        dailyGallons = (data.peopleCount || 0) * householdWaterNeeds.person;
        
        // Add bathroom usage
        if (data.bathroomCount) {
          dailyGallons += data.bathroomCount * householdWaterNeeds.bathroom;
        }
        
        // Add kitchen usage if mentioned
        if (data.fixturesInfo && data.fixturesInfo.toLowerCase().includes('kitchen')) {
          dailyGallons += householdWaterNeeds.kitchen;
        }
        
        // Add laundry if mentioned
        if (data.fixturesInfo && data.fixturesInfo.toLowerCase().includes('laundry')) {
          dailyGallons += householdWaterNeeds.laundry;
        }
        
        // Add garden if mentioned
        if (data.fixturesInfo && data.fixturesInfo.toLowerCase().includes('garden')) {
          if (data.fixturesInfo.toLowerCase().includes('large')) {
            dailyGallons += householdWaterNeeds.garden_large;
          } else if (data.fixturesInfo.toLowerCase().includes('medium')) {
            dailyGallons += householdWaterNeeds.garden_medium;
          } else {
            dailyGallons += householdWaterNeeds.garden_small;
          }
        }
        break;
        
      case USAGE_TYPES.IRRIGATION:
        // Base calculation on irrigation method and area
        let baseRate = irrigationWaterNeeds.sprinkler; // Default
        
        if (data.irrigationMethod === 'drip') {
          baseRate = irrigationWaterNeeds.drip;
        } else if (data.irrigationMethod === 'flood') {
          baseRate = irrigationWaterNeeds.flood;
        }
        
        // Apply crop type multiplier
        let cropMultiplier = 1.0;
        if (data.cropCategory === 'vegetables') {
          cropMultiplier = irrigationWaterNeeds.vegetables;
        } else if (data.cropCategory === 'fruits') {
          cropMultiplier = irrigationWaterNeeds.fruits;
        } else if (data.cropCategory === 'lawn') {
          cropMultiplier = irrigationWaterNeeds.lawn;
        }
        
        dailyGallons = baseRate * (data.irrigationArea || 1) * cropMultiplier;
        break;
        
      default:
        // Default to a reasonable value if we can't calculate
        dailyGallons = 500;
    }
  }
  
  // Default peak sun hours if not found in search
  let peakSunHours = 5.4;
  
  // Calculate required GPM
  requiredGPM = dailyGallons / (peakSunHours * 60);
  
  return {
    dailyGallons,
    requiredGPM,
    peakSunHours
  };
}

// Calculate pump recommendation
function calculateRecommendation(data) {
  // Calculate water requirements
  const waterReq = calculateWaterRequirements(data);
  
  // Use custom head if provided
  let tdh = data.customHead || 0;
  
  // If no custom head, calculate total dynamic head
  if (!tdh) {
    tdh = (data.staticWaterLevel || 0) + (data.drawdownLevel || 0) + (data.elevationGain || 0);
    
    // Add friction loss if pipe data exists
    if (data.pipeLength && data.pipeSize) {
      tdh += calculateFrictionLoss(waterReq.requiredGPM, data.pipeLength, data.pipeSize);
    }
  }
  
  // Check for sandy water
  if (data.sandyWater) {
    return {
      isValid: false,
      message: "Your water has too much sand for our solar pumps. You might want to consider contacting us directly for alternatives."
    };
  }
  
  // Check well casing size
  if (data.wellCasingSize && data.wellCasingSize < 5) {
    return {
      isValid: false,
      message: "Our pumps require a well casing of 5 inches or larger. Your well casing is too small for our pumps. Please contact us for assistance."
    };
  }
  
  // Select appropriate pump model
  let selectedPump = null;
  let pumpStages = 0;
  
  for (const [model, specs] of Object.entries(pumpData)) {
    if (specs.maxFlow >= waterReq.requiredGPM && specs.maxHead >= tdh) {
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
  const pumpOutput = pumpData[selectedPump].maxFlow * (waterReq.peakSunHours * 60);
  
  // Create a clean, formatted summary text for easy copying
  const formattedSummary = `
WATER SYSTEM SPECIFICATIONS
===============================
Usage type: ${data.usageType.toUpperCase()}
${data.usageType === USAGE_TYPES.LIVESTOCK ? 
  `Livestock: ${data.animalCount} ${data.livestockType}` : 
  data.usageType === USAGE_TYPES.HOUSEHOLD ? 
    `Household: ${data.peopleCount} people, ${data.bathroomCount || 0} bathrooms` : 
    data.usageType === USAGE_TYPES.IRRIGATION ? 
      `Irrigation: ${data.irrigationArea} acres, ${data.irrigationMethod} system, ${data.cropType}` : 
      `Custom requirements`}

WATER REQUIREMENTS
--------------------------------
Daily water needed: ${waterReq.dailyGallons.toFixed(0)} gallons
Required flow rate: ${waterReq.requiredGPM.toFixed(2)} GPM
Peak sun hours: ${waterReq.peakSunHours} hours

WELL SPECIFICATIONS
--------------------------------
Well depth: ${data.wellDepth || 'Not specified'} feet
Static water level: ${data.staticWaterLevel || 'Not specified'} feet
Drawdown: ${data.drawdownLevel || 'Not specified'} feet ${data.drawdownEstimated ? '(estimated)' : ''}
Elevation gain: ${data.elevationGain || 'Not specified'} feet
Total Dynamic Head: ${tdh.toFixed(1)} feet

PUMP RECOMMENDATION
================================
Model: ${selectedPump}
Stages: ${pumpStages}
Max flow capacity: ${pumpData[selectedPump].maxFlow} GPM
Max head capacity: ${pumpData[selectedPump].maxHead} feet
Daily output: ${pumpOutput.toFixed(0)} gallons

SOLAR CONFIGURATION
--------------------------------
System voltage: 48V
Total power required: ${powerRequired} watts
Recommended panels: ${adjustedPanels} x 100W panels (${adjustedPanels/2} series pairs)
`;
  
  return {
    isValid: true,
    waterRequirements: {
      dailyGallons: waterReq.dailyGallons,
      requiredGPM: waterReq.requiredGPM.toFixed(2)
    },
    pumpDetails: {
      model: selectedPump,
      stages: pumpStages,
      maxFlow: pumpData[selectedPump].maxFlow,
      maxHead: pumpData[selectedPump].maxHead
    },
    system: {
      tdh: tdh.toFixed(1),
      peakSunHours: waterReq.peakSunHours,
      panelsRequired: adjustedPanels,
      dailyOutput: pumpOutput.toFixed(0)
    },
    solarConfig: {
      voltage: 48,
      wattage: adjustedPanels * 100,
      description: `${adjustedPanels} panels (${adjustedPanels/2} series pairs of 24V/100W panels)`
    },
    formattedSummary
  };
}

// Debug endpoint to check session data
app.get('/api/debug/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (sessions[sessionId]) {
    res.json({
      currentStage: sessions[sessionId].currentStage,
      data: sessions[sessionId].data,
      messageCount: sessions[sessionId].messages.length
    });
  } else {
    res.json({ error: "Session not found" });
  }
});

// Test endpoint - Keep this exact format which we know works
app.get('/', (req, res) => {
  res.send('Solar Pump Chatbot API is running - Test Version');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
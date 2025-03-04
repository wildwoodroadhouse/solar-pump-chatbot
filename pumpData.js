// pumpData.js - Flow rate at different head values for each pump model
const pumpData = {
    "1S48V50C": {
      "stages": 1,
      "voltage": 48,
      "flowRateByHead": [
        { head: 0, flowRate: 5.0 },     // Assumed maximum flow at 0 head
        { head: 12.5, flowRate: 5.0 },
        { head: 22.5, flowRate: 4.0 },
        { head: 30, flowRate: 3.0 },
        { head: 37.5, flowRate: 2.0 },
        { head: 40, flowRate: 1.0 }
      ],
      "maxFlow": 5.0,
      "maxHead": 40,
      "powerRequired": 53  // 53W × 1 stage
    },
    "2S48V50C": {
      "stages": 2,
      "voltage": 48,
      "flowRateByHead": [
        { head: 0, flowRate: 5.0 },     // Assumed maximum flow at 0 head
        { head: 25, flowRate: 5.0 },
        { head: 45, flowRate: 4.0 },
        { head: 60, flowRate: 3.0 },
        { head: 75, flowRate: 2.0 },
        { head: 80, flowRate: 1.0 }
      ],
      "maxFlow": 5.0,
      "maxHead": 80,
      "powerRequired": 106  // 53W × 2 stages
    },
    "3S48V50C": {
      "stages": 3,
      "voltage": 48,
      "flowRateByHead": [
        { head: 0, flowRate: 5.0 },     // Assumed maximum flow at 0 head
        { head: 37.5, flowRate: 5.0 },
        { head: 67.5, flowRate: 4.0 },
        { head: 90, flowRate: 3.0 },
        { head: 112.5, flowRate: 2.0 },
        { head: 120, flowRate: 1.0 }
      ],
      "maxFlow": 5.0,
      "maxHead": 120,
      "powerRequired": 159  // 53W × 3 stages
    },
    "4S48V50C": {
      "stages": 4,
      "voltage": 48,
      "flowRateByHead": [
        { head: 0, flowRate: 5.0 },     // Assumed maximum flow at 0 head
        { head: 50, flowRate: 5.0 },
        { head: 90, flowRate: 4.0 },
        { head: 120, flowRate: 3.0 },
        { head: 150, flowRate: 2.0 },
        { head: 160, flowRate: 1.0 }
      ],
      "maxFlow": 5.0,
      "maxHead": 160,
      "powerRequired": 212  // 53W × 4 stages
    },
    "5S48V50C": {
      "stages": 5,
      "voltage": 48,
      "flowRateByHead": [
        { head: 0, flowRate: 5.0 },     // Assumed maximum flow at 0 head
        { head: 62.5, flowRate: 5.0 },
        { head: 112.5, flowRate: 4.0 },
        { head: 150, flowRate: 3.0 },
        { head: 187.5, flowRate: 2.0 },
        { head: 200, flowRate: 1.0 }
      ],
      "maxFlow": 5.0,
      "maxHead": 200,
      "powerRequired": 265  // 53W × 5 stages
    },
    "6S48V50C": {
      "stages": 6,
      "voltage": 48,
      "flowRateByHead": [
        { head: 0, flowRate: 5.0 },     // Assumed maximum flow at 0 head
        { head: 75, flowRate: 5.0 },
        { head: 135, flowRate: 4.0 },
        { head: 180, flowRate: 3.0 },
        { head: 225, flowRate: 2.0 },
        { head: 240, flowRate: 1.0 }
      ],
      "maxFlow": 5.0,
      "maxHead": 240,
      "powerRequired": 318  // 53W × 6 stages
    }
  };
  
  // Helper function to find the right pump model
  function findSuitablePump(requiredGPM, requiredHead) {
    const suitablePumps = [];
    
    for (const [model, data] of Object.entries(pumpData)) {
      // If the head requirement exceeds this pump's capability, skip it
      if (requiredHead > data.maxHead) {
        continue;
      }
      
      // Find the flow rate at the required head
      let actualFlowRate = 0;
      
      // Check each point on the pump curve
      for (let i = 0; i < data.flowRateByHead.length - 1; i++) {
        const point1 = data.flowRateByHead[i];
        const point2 = data.flowRateByHead[i + 1];
        
        // If head is between these two points, interpolate the flow rate
        if (requiredHead >= point1.head && requiredHead <= point2.head) {
          // Linear interpolation
          const slope = (point2.flowRate - point1.flowRate) / (point2.head - point1.head);
          actualFlowRate = point1.flowRate + slope * (requiredHead - point1.head);
          break;
        }
      }
      
      // If flow rate is sufficient, add to suitable pumps
      if (actualFlowRate >= requiredGPM) {
        suitablePumps.push({
          model,
          stages: data.stages,
          flowRate: actualFlowRate,
          powerRequired: data.powerRequired
        });
      }
    }
    
    // Return the pump with the fewest stages (most efficient)
    return suitablePumps.sort((a, b) => a.stages - b.stages)[0];
  }
  
  module.exports = {
    pumpData,
    findSuitablePump
  };
#ifndef LIGHTING_CONTROL_H
#define LIGHTING_CONTROL_H

#include <Arduino.h>
#include <EEPROM.h>
#include <ArduinoJson.h>
#include "driver/ledc.h"  // ESP32 PWM library
#include <WebSocketsServer.h>  // https://github.com/Links2004/arduinoWebSockets
#include <Adafruit_AHTX0.h>    // AHT sensor library

// Forward declarations
String formatMillisToHMS(unsigned long ms);
String getCurrentTime();

// External declarations
extern WebSocketsServer ws;  // WebSocket server instance from main file
extern Adafruit_AHTX0 aht;   // AHT sensor instance from main file

// Lighting modes
enum LightingMode {
    LIGHTING_MODE_AUTO,
    LIGHTING_MODE_MANUAL
};

// EEPROM settings
#define EEPROM_SIZE 1024
#define LIGHTING_CONFIG_ADDR 0

// PWM settings
#define LIGHT_PIN 5  // Using D5/GPIO 5 for PWM output
#define PWM_CHANNEL LEDC_CHANNEL_0
#define PWM_FREQ 5000
#define PWM_RESOLUTION LEDC_TIMER_8_BIT  // 8-bit resolution (0-255)

// Maximum number of schedules
#define MAX_SCHEDULES 24

// Structure to hold lighting event information
struct LightingEvent {
    char triggerTime[9];      // Format: "HH:MM:SS"
    uint8_t lightIntensity;   // 0-255
    bool enabled;            // Whether this event is active
};

// Global state (using slot 0)
struct GlobalState {
    uint8_t lightIntensity;   // Current light intensity (0-255)
    uint8_t maxIntensity;     // Maximum allowed light intensity (0-255)
    bool enabled;            // Global enable/disable
    uint8_t tempThreshold;   // Temperature threshold in Celsius
    bool overTemp;           // Over temperature flag
    bool autoMode;           // Auto/Manual mode
    char timezone[32];       // Timezone string
    char overTempTimestamp[32]; // Timestamp of last over-temperature change
    int8_t activeEventIndex;  // Index of currently active event (-1 if none)
    uint8_t activeIntensity;  // Current active intensity value
    bool lightSensorState;   // false = no light detected, true = light detected
    LightingEvent events[MAX_SCHEDULES];  // Add events array to globalState
};

// Global variables
LightingEvent events[MAX_SCHEDULES];
GlobalState globalState;
bool lightingEnabled = false;
uint8_t currentIntensity = 0;
LightingMode lightingMode = LIGHTING_MODE_AUTO;
unsigned long lastLightingCheck = 0;

// Forward declarations
void initLighting();
void handleLightingWebRequest(WiFiClient& client, const String& request, const char* version, Adafruit_AHTX0& aht);
void saveSchedulesToEEPROM();
void loadSchedulesFromEEPROM();
void updateLighting();
String getLightingStatusJSON();
String getSchedulesJSON();
void handleWebSocketMessage(uint8_t num, uint8_t * payload, size_t length);

// Initialize lighting control
void initLighting() {
    // Initialize EEPROM if needed
    if (!EEPROM.begin(EEPROM_SIZE)) {
        Serial.println("[Init] Failed to initialize EEPROM");
        return;
    }

    // Disable WebSocket server debug messages
    ws.enableHeartbeat(15000, 3000, 2);

    // Load existing state from EEPROM
    loadSchedulesFromEEPROM();

    // Initialize timezone if not set
    if (strlen(globalState.timezone) == 0) {
        strncpy(globalState.timezone, "America/Los_Angeles", sizeof(globalState.timezone) - 1);
        globalState.timezone[sizeof(globalState.timezone) - 1] = '\0';
        saveSchedulesToEEPROM();
    }

    // Configure PWM
    ledc_timer_config_t ledc_timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = PWM_RESOLUTION,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = PWM_FREQ,
        .clk_cfg = LEDC_AUTO_CLK
    };
    ledc_timer_config(&ledc_timer);

    ledc_channel_config_t ledc_channel = {
        .gpio_num = LIGHT_PIN,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = PWM_CHANNEL,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
        .hpoint = 0
    };
    ledc_channel_config(&ledc_channel);
    
    // Initialize lighting state from global state
    lightingEnabled = globalState.enabled;
    lightingMode = globalState.autoMode ? LIGHTING_MODE_AUTO : LIGHTING_MODE_MANUAL;
    
    Serial.printf("[Init] Mode: %s, Enabled: %d\n", 
                 lightingMode == LIGHTING_MODE_AUTO ? "Auto" : "Manual",
                 lightingEnabled);
    
    // Set initial intensity based on current mode
    if (lightingMode == LIGHTING_MODE_MANUAL) {
        currentIntensity = globalState.lightIntensity;
        Serial.printf("[Init] Set manual intensity to: %d\n", currentIntensity);
    }

    // Find the current active event and set its intensity
    struct tm timeinfo;
    if (getLocalTime(&timeinfo)) {
        int currentTimeSeconds = timeinfo.tm_hour * 3600 + timeinfo.tm_min * 60 + timeinfo.tm_sec;
        int8_t activeIndex = -1;
        int mostRecentTime = -1;
        uint8_t activeIntensity = 0;

        // Look for events earlier today
        for (int i = 0; i < MAX_SCHEDULES; i++) {
            if (!events[i].enabled || !events[i].triggerTime[0]) continue;

            int hours, minutes, seconds;
            sscanf(events[i].triggerTime, "%d:%d:%d", &hours, &minutes, &seconds);
            int eventTimeSeconds = hours * 3600 + minutes * 60 + seconds;

            if (eventTimeSeconds <= currentTimeSeconds && eventTimeSeconds > mostRecentTime) {
                mostRecentTime = eventTimeSeconds;
                activeIndex = i;
                activeIntensity = events[i].lightIntensity;
            }
        }

        // If no event found today, use the latest event from yesterday
        if (activeIndex == -1) {
            mostRecentTime = -1;
            for (int i = 0; i < MAX_SCHEDULES; i++) {
                if (!events[i].enabled || !events[i].triggerTime[0]) continue;

                int hours, minutes, seconds;
                sscanf(events[i].triggerTime, "%d:%d:%d", &hours, &minutes, &seconds);
                int eventTimeSeconds = hours * 3600 + minutes * 60 + seconds;

                if (eventTimeSeconds > mostRecentTime) {
                    mostRecentTime = eventTimeSeconds;
                    activeIndex = i;
                    activeIntensity = events[i].lightIntensity;
                }
            }
        }

        // Set the active event and intensity
        globalState.activeEventIndex = activeIndex;
        globalState.activeIntensity = activeIntensity;
    }

    // Start the lighting update interval
    lastLightingCheck = millis();
}

// Convert time string (HH:MM:SS) to seconds since midnight
unsigned long timeToSeconds(const char* timeStr) {
    int hours, mins, secs;
    sscanf(timeStr, "%d:%d:%d", &hours, &mins, &secs);
    return (hours * 3600UL) + (mins * 60UL) + secs;
}

// Convert seconds since midnight to time string (HH:MM:SS)
String secondsToTime(unsigned long seconds) {
    int hours = seconds / 3600;
    int mins = (seconds % 3600) / 60;
    int secs = seconds % 60;
    char timeStr[9];
    snprintf(timeStr, sizeof(timeStr), "%02d:%02d:%02d", hours, mins, secs);
    return String(timeStr);
}

// Save schedules to EEPROM
void saveSchedulesToEEPROM() {
    // Save global state first
    EEPROM.put(0, globalState);
    
    // Save events starting after global state
    EEPROM.put(sizeof(GlobalState), events);
    EEPROM.commit();
}

// Load schedules from EEPROM
void loadSchedulesFromEEPROM() {
    // Load global state first
    EEPROM.get(0, globalState);
    
    Serial.printf("[EEPROM] Loaded lightIntensity: %d\n", globalState.lightIntensity);
    Serial.printf("[EEPROM] Loaded overTemp state: %d\n", globalState.overTemp);
    
    // Apply global state
    currentIntensity = globalState.lightIntensity;
    lightingEnabled = globalState.enabled;
    lightingMode = globalState.autoMode ? LIGHTING_MODE_AUTO : LIGHTING_MODE_MANUAL;
    
    Serial.printf("[EEPROM] Set currentIntensity to: %d\n", currentIntensity);
    
    // Load events
    EEPROM.get(sizeof(GlobalState), events);
}

// Update lighting based on current time and events
void updateLighting() {
    // Safety checks first - applies to ALL modes
    if (!globalState.enabled || globalState.overTemp) {
        Serial.printf("[Lighting] Safety check failed - enabled: %d, overTemp: %d\n", 
                     globalState.enabled, globalState.overTemp);
        ledc_set_duty(LEDC_LOW_SPEED_MODE, PWM_CHANNEL, 0);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, PWM_CHANNEL);
        globalState.activeEventIndex = -1;
        globalState.activeIntensity = 0;
        return;
    }

    // System is enabled and not over temperature, handle modes
    if (!globalState.autoMode) {
        // Manual mode
        Serial.printf("[Lighting] Manual mode - setting intensity to: %d\n", currentIntensity);
        ledc_set_duty(LEDC_LOW_SPEED_MODE, PWM_CHANNEL, currentIntensity);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, PWM_CHANNEL);
    } else {
        // Auto mode
        struct tm timeinfo;
        if (!getLocalTime(&timeinfo)) {
            Serial.println("[Lighting] Failed to obtain time");
            return;
        }

        // Convert current time to seconds since midnight
        int currentTimeSeconds = timeinfo.tm_hour * 3600 + timeinfo.tm_min * 60 + timeinfo.tm_sec;
        Serial.printf("[Lighting] Current time in seconds: %d\n", currentTimeSeconds);
        
        // Find the most recent event
        int8_t newActiveIndex = -1;
        int mostRecentTime = -1;
        uint8_t newIntensity = 0;

        // First pass: look for events earlier today
        for (int i = 0; i < MAX_SCHEDULES; i++) {
            if (!events[i].enabled || !events[i].triggerTime[0]) continue;

            int hours, minutes, seconds;
            sscanf(events[i].triggerTime, "%d:%d:%d", &hours, &minutes, &seconds);
            int eventTimeSeconds = hours * 3600 + minutes * 60 + seconds;

            if (eventTimeSeconds <= currentTimeSeconds && eventTimeSeconds > mostRecentTime) {
                mostRecentTime = eventTimeSeconds;
                newActiveIndex = i;
                newIntensity = events[i].lightIntensity;
                Serial.printf("[Lighting] Found earlier event today - index: %d, time: %d, intensity: %d\n", 
                            i, eventTimeSeconds, newIntensity);
            }
        }

        // If no event found today, use the latest event from yesterday
        if (newActiveIndex == -1) {
            mostRecentTime = -1;
            for (int i = 0; i < MAX_SCHEDULES; i++) {
                if (!events[i].enabled || !events[i].triggerTime[0]) continue;

                int hours, minutes, seconds;
                sscanf(events[i].triggerTime, "%d:%d:%d", &hours, &minutes, &seconds);
                int eventTimeSeconds = hours * 3600 + minutes * 60 + seconds;

                if (eventTimeSeconds > mostRecentTime) {
                    mostRecentTime = eventTimeSeconds;
                    newActiveIndex = i;
                    newIntensity = events[i].lightIntensity;
                    Serial.printf("[Lighting] Found latest event from yesterday - index: %d, time: %d, intensity: %d\n", 
                                i, eventTimeSeconds, newIntensity);
                }
            }
        }

        // Update active event if changed
        if (newActiveIndex != globalState.activeEventIndex) {
            Serial.printf("[Lighting] Active event changed from %d to %d\n", 
                        globalState.activeEventIndex, newActiveIndex);
            globalState.activeEventIndex = newActiveIndex;
            globalState.activeIntensity = newIntensity;
            
            // Broadcast the status update
            if (ws.connectedClients() > 0) {
                String status = getLightingStatusJSON();
                ws.broadcastTXT(status);
            }
        }

        // Always update PWM duty cycle based on current active event
        uint8_t finalIntensity = min((uint8_t)newIntensity, globalState.maxIntensity);
        Serial.printf("[Lighting] Auto mode - setting intensity to: %d (from event intensity: %d, max: %d)\n", 
                     finalIntensity, newIntensity, globalState.maxIntensity);
        ledc_set_duty(LEDC_LOW_SPEED_MODE, PWM_CHANNEL, finalIntensity);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, PWM_CHANNEL);
    }
}

// Get current lighting status as JSON
String getLightingStatusJSON() {
    StaticJsonDocument<400> doc;
    doc["enabled"] = globalState.enabled;
    doc["autoMode"] = globalState.autoMode;
    doc["intensity"] = globalState.lightIntensity;
    
    // Add global state
    doc["maxIntensity"] = globalState.maxIntensity;
    doc["maxTemp"] = globalState.tempThreshold;
    doc["overTemp"] = globalState.overTemp;
    doc["overTempTimestamp"] = globalState.overTempTimestamp;
    doc["timezone"] = globalState.timezone;
    doc["activeEventIndex"] = globalState.activeEventIndex;
    doc["activeIntensity"] = globalState.activeIntensity;
    
    // Add current temperature in both F and C
    sensors_event_t humidity, temp;
    aht.getEvent(&humidity, &temp);
    float currentTempF = (temp.temperature * 9.0f / 5.0f) + 32.0f;
    float currentTempC = temp.temperature;
    doc["currentTempF"] = currentTempF;
    doc["currentTempC"] = currentTempC;
    
    String output;
    serializeJson(doc, output);
    return output;
}

// Get all events as JSON
String getSchedulesJSON() {
    StaticJsonDocument<1024> doc;
    
    // Add global state first
    JsonObject global = doc.createNestedObject("global");
    global["maxIntensity"] = globalState.maxIntensity;
    global["tempThreshold"] = globalState.tempThreshold;
    global["overTemp"] = globalState.overTemp;
    global["enabled"] = lightingEnabled;
    global["autoMode"] = globalState.autoMode;
    global["intensity"] = currentIntensity;
    
    // Add events
    JsonArray eventArray = doc.createNestedArray("events");
    for (int i = 0; i < MAX_SCHEDULES; i++) {
        JsonObject event = eventArray.createNestedObject();
        event["triggerTime"] = events[i].triggerTime;
        event["lightIntensity"] = events[i].lightIntensity;
        event["enabled"] = events[i].enabled;
    }
    
    String output;
    serializeJson(doc, output);
    return output;
}

// Handle web requests for lighting control
void handleLightingWebRequest(WiFiClient& client, const String& request, const char* version, Adafruit_AHTX0& aht) {
    // Handle API endpoints first
    if (request.indexOf("GET /api/lighting/schedules") >= 0) {
        // Get the JSON string
        String scheduleJson = getSchedulesJSON();
        
        // Send headers
        client.println("HTTP/1.1 200 OK");
        client.println("Content-Type: application/json");
        client.println("Access-Control-Allow-Origin: *");
        client.println("Connection: close");
        client.println();
        
        // Send the JSON response
        client.print(scheduleJson);
        return;  // Important to return here!
    }
    else if (request.indexOf("GET /api/lighting/status") >= 0) {
        client.println("HTTP/1.1 200 OK");
        client.println("Content-Type: application/json");
        client.println("Connection: close");
        client.println();
        client.println(getLightingStatusJSON());
        return;  // Important to return here!
    }
    else if (request.indexOf("GET /api/device/info") >= 0) {
        sensors_event_t humidity, temp;
        aht.getEvent(&humidity, &temp);

        StaticJsonDocument<200> doc;
        doc["temperature"] = temp.temperature;
        doc["humidity"] = humidity.relative_humidity;
        doc["ip"] = WiFi.localIP().toString();
        doc["uptime"] = formatMillisToHMS(millis());
        doc["currentTime"] = getCurrentTime();
        
        String output;
        serializeJson(doc, output);
        
        client.println("HTTP/1.1 200 OK");
        client.println("Content-Type: application/json");
        client.println("Connection: close");
        client.println();
        client.println(output);
        return;  // Important to return here!
    }
    
    // Then handle page requests
    if (request.indexOf("GET /lighting") >= 0) {
        // Serve the lighting control page
        String html = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Lighting Control</title>
    <style>
        :root {
            --bg-primary: #181a1b;
            --text-primary: #e8e6e3;
            --text-secondary: #b2aba1;
            --border-color: #736b5e;
            --success-color: #3d8c40;
            --error-color: #a91409;
            --active-color: #998100;
            --inactive-color: #4f5559;
            --selection-bg: #004daa;
            --selection-text: #e8e6e3;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 1rem;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.5;
            font-size: 1rem;
            min-height: 100vh;
        }

        ::selection {
            background-color: var(--selection-bg);
            color: var(--selection-text);
        }

        h1, h2, h3 {
            color: var(--text-primary);
            margin-bottom: 1rem;
        }

        .container {
            background-color: var(--bg-primary);
            padding: 1rem;
            border-radius: 0.5rem;
            margin-bottom: 1rem;
            width: 100%;
        }

        .controls {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            margin-bottom: 1rem;
        }

        .slider-container {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.5rem;
            margin-bottom: 1rem;
            width: 100%;
        }

        .slider-container label {
            min-width: 120px;
        }

        #intensitySlider {
            flex: 1;
            min-width: 200px;
        }

        .setting-container {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.5rem;
            margin-bottom: 0.5rem;
            width: 100%;
        }

        .input-group {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            flex: 1;
        }

        .setting-container label {
            min-width: 150px;
        }

        .setting-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-left: auto;
        }

        .setting-container input,
        .setting-container select {
            text-align: left;
            flex: 0 1 auto;
        }

        .setting-container input {
            width: auto;
            min-width: 80px;
            padding: 0.5rem;
            border: 1px solid var(--border-color);
            border-radius: 0.25rem;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            height: 38px;
            box-sizing: border-box;
        }

        .setting-container button {
            height: 38px;
            padding: 0 1rem;
            margin: 0;
        }

        .event-controls {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.5rem;
            margin-left: auto;
        }

        .event-controls .active-label {
            background-color: var(--active-color);
            color: var(--text-primary);
            padding: 0.5rem 1rem;
            border-radius: 0.25rem;
            font-size: 1rem;
            min-width: 100px;
            text-align: center;
            white-space: nowrap;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 34px;
        }

        .event-controls .inactive-label {
            background-color: var(--inactive-color);
            color: var(--text-primary);
            padding: 0.5rem 1rem;
            border-radius: 0.25rem;
            font-size: 1rem;
            min-width: 100px;
            text-align: center;
            white-space: nowrap;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 34px;
        }

        .event-form {
            background-color: #333;
            border: 1px solid var(--border-color);
            border-radius: 0.25rem;
            padding: 0.5rem;
            margin-bottom: 1rem;
        }

        .event-form .setting-container {
            margin-bottom: 0.5rem;
        }

        .event-form button {
            margin-top: 0.5rem;
        }

        .button-full-width {
            width: 100%;
        }

        .button-light-sensor {
            min-width: auto;
        }

        button {
            padding: 0.5rem 1rem;
            border: none;
            border-radius: 0.25rem;
            cursor: pointer;
            font-size: 1rem;
            transition: background-color 0.2s;
            min-width: 100px;
            white-space: nowrap;
            color: white;
        }

        .button-enabled {
            background-color: var(--success-color);
        }

        .button-disabled {
            background-color: var(--error-color);
        }

        .button-auto {
            background-color: var(--success-color);
        }

        .button-manual {
            background-color: var(--active-color);
        }

        .button-true {
            background-color: var(--success-color);
            color: var(--text-primary);
        }

        .button-false {
            background-color: var(--danger-color);
            color: var(--text-primary);
        }

        .button-light-detected {
            background-color: var(--active-color) !important;  /* Dark yellow/gold matching Active box */
            color: var(--text-primary) !important;
        }

        .button-no-light {
            background-color: #004080 !important;  /* Darker blue */
            color: var(--text-primary) !important;
        }

        .button-delete {
            background-color: var(--error-color);
        }

        .btn-success {
            background-color: var(--success-color);
        }

        .btn-danger {
            background-color: var(--error-color);
        }

        .btn-warning {
            background-color: var(--active-color);
        }

        .btn-secondary {
            background-color: var(--inactive-color);
        }

        .setting-container button {
            background-color: var(--success-color);
        }

        .setting-container .button-true {
            background-color: var(--error-color);
        }

        .setting-container .button-false {
            background-color: var(--success-color);
        }

        @media (max-width: 600px) {
            body {
                padding: 0.5rem;
                font-size: 1.1rem;
            }

            .container {
                padding: 0.5rem;
            }

            .setting-container {
                flex-direction: column;
                align-items: stretch;
            }

            .setting-container label {
                margin-bottom: 0.25rem;
            }

            .event-item {
                flex-direction: column;
                align-items: stretch;
            }

            .event-controls {
                margin-left: 0;
                justify-content: flex-start;
            }

            button {
                width: 100%;
                margin: 0.25rem 0;
            }

            #intensitySlider {
                width: 100%;
            }
        }

        .event-list {
            margin-bottom: 1rem;
        }

        .event-item {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem;
            background-color: #333;
            border: 1px solid var(--border-color);
            border-radius: 0.25rem;
            margin-bottom: 0.5rem;
        }

        .event-item:last-child {
            margin-bottom: 0;
        }

        .device-info {
            margin: 20px 0;
            padding: 15px;
            border: 1px solid #ddd;
            border-radius: 5px;
            background: #333;
        }

        .slider-container input[type="number"] {
            width: auto;
            min-width: 80px;
            padding: 0.5rem;
            border: 1px solid var(--border-color);
            border-radius: 0.25rem;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            height: 38px;
            box-sizing: border-box;
        }

        .temp-container {
            display: inline-flex;
            align-items: center;
            white-space: nowrap;
            margin-left: 8px;
            font-family: monospace;
            font-size: 1.2rem;
            color: #ffffff;
        }
        
        .timezone-select {
            min-width: 200px;
            font-size: 1rem;
            padding: 0.5rem;
            border: 1px solid var(--border-color);
            border-radius: 0.25rem;
            background-color: var(--bg-primary);
            color: var(--text-primary);
            height: 38px;
            box-sizing: border-box;
        }

        .clock-display {
            font-family: monospace;
            font-size: 1.2rem;
            margin-left: auto;
            padding: 0.5rem;
            background-color: #333;
            border-radius: 0.25rem;
            min-width: 120px;
            text-align: center;
        }

        .temp-container {
            display: inline-flex;
            align-items: center;
            white-space: nowrap;
            margin-left: 8px;
            font-family: monospace;
            font-size: 1.2rem;
            color: #ffffff;
        }
    </style>
</head>
<body>
    <div class="container">
        <h2>Lighting Control</h2>
        
        <div class="event-form">
            <div class="controls">
                <button id="toggleButton" onclick="toggleLighting()" class="button-disabled">Disabled</button>
                <button id="modeButton" onclick="toggleMode()" class="button-auto">Auto Mode</button>
                <div id="clock" class="clock-display">--:--:--</div>
                <div class="temp-container">(<span id="currentTempF">--</span>°F / <span id="currentTempC">--</span>°C)</div>
            </div>

            <div class="setting-container">
                <div class="input-group">
                    <label>Manual Intensity:</label>
                    <input type="number" id="intensityValue" min="0" max="255" onkeypress="handleIntensityKeyPress(event)">
                </div>
                <button id="intensitySetButton" onclick="setManualIntensity()">Set</button>
            </div>

            <div class="setting-container">
                <div class="input-group">
                    <label>Max Intensity:</label>
                    <input type="number" id="maxIntensity" min="0" max="100" value="100">
                </div>
                <button onclick="updateGlobalSettings()">Set</button>
            </div>

            <div class="setting-container">
                <div class="input-group">
                    <label>Max Temperature F:</label>
                    <input type="number" id="maxTemp" min="0" max="100" value="100">
                </div>
                <button onclick="updateGlobalSettings()">Set</button>
            </div>

            <div class="setting-container">
                <div class="input-group">
                    <label for="overTempButton">Over Temperature:</label>
                    <span id="overTempTimestamp" class="timestamp"></span>
                </div>
                <button id="overTempButton" class="button-false" onclick="toggleOverTemp()">False</button>
            </div>

            <div class="setting-container">
                <div class="input-group">
                    <label for="lightSensorButton">Light Sensor:</label>
                    <span id="lightSensorError" class="error-text"></span>
                </div>
                <button id="lightSensorButton" class="button-no-light button-light-sensor" onclick="toggleLightSensor()">No Light Detected</button>
            </div>

            <div class="setting-container">
                <div class="input-group">
                    <label for="timezone">Time Zone:</label>
                    <select id="timezone" class="timezone-select">
                        <option value="America/Los_Angeles">Pacific Time (PT)</option>
                        <option value="America/Denver">Mountain Time (MT)</option>
                        <option value="America/Chicago">Central Time (CT)</option>
                        <option value="America/New_York">Eastern Time (ET)</option>
                        <option value="America/Anchorage">Alaska Time (AKT)</option>
                        <option value="Pacific/Honolulu">Hawaii Time (HT)</option>
                    </select>
                </div>
                <button onclick="updateGlobalSettings()">Set</button>
            </div>
        </div>

        <h2>Add New Event</h2>
        <div class="event-form">
            <div class="setting-container">
                <label>Trigger Time (HH:MM:SS)</label>
                <input type="text" id="triggerTime" class="form-control" pattern="[0-9]{2}:[0-9]{2}:[0-9]{2}" placeholder="HH:MM:SS">
            </div>
            <div class="setting-container">
                <label for="lightIntensity">Light Intensity (0-255):</label>
                <input type="number" id="lightIntensity" min="0" max="255" required>
            </div>
            <button type="submit" class="button-full-width btn-success" onclick="addEvent()">Add Event</button>
        </div>

        <h2>Active Events</h2>
        <div id="eventList" class="event-list">
            <!-- Events will be populated here -->
        </div>
    </div>

    <script>
        let ws = null;
        let currentSchedules = [];
        let isEnabled = false;
        let isManualMode = false;
        let currentIntensity = 0;
        let globalState = {
            maxIntensity: 255,
            maxTemp: 85,
            timezone: 'America/Los_Angeles',
            activeEventIndex: -1,
            lightSensorState: false,  // false = no light detected, true = light detected
            events: []  // Add events array to globalState
        };
        
        function connectWebSocket() {
            ws = new WebSocket('ws://' + window.location.hostname + ':81/ws');
            
            ws.onopen = function() {
                // Request initial status
                ws.send(JSON.stringify({type: 'get_status'}));
                // Initial schedule fetch
                fetchSchedule();
            };
            
            ws.onclose = function() {
                // Try to reconnect in 5 seconds
                setTimeout(connectWebSocket, 5000);
            };
            
            ws.onmessage = function(event) {
                try {
                    const data = JSON.parse(event.data);
                    updateStatus(data);
                } catch (e) {
                    console.error('Error parsing WebSocket message:', e);
                }
            };
            
            ws.onerror = function(error) {
                console.error('WebSocket error:', error);
            };
        }
        
        function updateClock() {
            const clockElement = document.getElementById('clock');
            if (!clockElement) return; // Skip if element doesn't exist
            
            const now = new Date();
            const timezone = document.getElementById('timezone')?.value || 'America/Los_Angeles';
            
            try {
                // Format the time first
                const timeString = now.toLocaleTimeString('en-US', { 
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    timeZone: timezone
                });
                
                // Get timezone abbreviation
                let tzAbbr = '';
                try {
                    const tzParts = new Intl.DateTimeFormat('en-US', {
                        timeZone: timezone,
                        timeZoneName: 'short'
                    }).formatToParts(now);
                    
                    const tzPart = tzParts.find(part => part.type === 'timeZoneName');
                    if (tzPart) {
                        tzAbbr = tzPart.value;
                    }
                } catch (tzError) {
                    console.error('Error getting timezone abbreviation:', tzError);
                    // Use a fallback based on the timezone value
                    if (timezone.includes('Los_Angeles')) tzAbbr = 'PT';
                    else if (timezone.includes('Denver')) tzAbbr = 'MT';
                    else if (timezone.includes('Chicago')) tzAbbr = 'CT';
                    else if (timezone.includes('New_York')) tzAbbr = 'ET';
                    else if (timezone.includes('Anchorage')) tzAbbr = 'AKT';
                    else if (timezone.includes('Honolulu')) tzAbbr = 'HT';
                    else tzAbbr = 'PT'; // Default to PT if no match
                }
                
                clockElement.textContent = timeString + ' ' + tzAbbr;
            } catch (error) {
                console.error('Error updating clock:', error);
                clockElement.textContent = 'Error';
            }
        }
        
        function updateStatus(data) {
            // Update current intensity
            if (data.intensity !== undefined) {
                currentIntensity = data.intensity;
                const intensityInput = document.getElementById('intensityValue');
                // Only update if the input is not focused (user is not editing)
                if (intensityInput && document.activeElement !== intensityInput) {
                    intensityInput.value = currentIntensity;
                }
            }
            
            // Update global settings
            if (data.maxTemp !== undefined) {
                const maxTempInput = document.getElementById('maxTemp');
                // Only update if the input is not focused
                if (maxTempInput && document.activeElement !== maxTempInput) {
                    maxTempInput.value = data.maxTemp;
                }
            }

            // Update global state
            if (data.maxIntensity !== undefined) {
                globalState.maxIntensity = data.maxIntensity;
                const maxIntensityInput = document.getElementById('maxIntensity');
                // Only update if the input is not focused
                if (maxIntensityInput && document.activeElement !== maxIntensityInput) {
                    maxIntensityInput.value = data.maxIntensity;
                }
                updateMaxIntensityDisplay();
            }
            
            // Update mode state
            if (data.autoMode !== undefined) {
                const autoModeButton = document.getElementById('modeButton');
                if (autoModeButton) {
                    isManualMode = !data.autoMode;  // Update local state to match server
                    
                    if (data.autoMode) {
                        autoModeButton.textContent = 'Auto Mode';
                        autoModeButton.className = 'button-auto';
                    } else {
                        autoModeButton.textContent = 'Manual Mode';
                        autoModeButton.className = 'button-manual';
                    }
                }
            }
            
            // Update active event display
            if (data.activeEventIndex !== undefined) {
                globalState.activeEventIndex = data.activeEventIndex;
                // Remove any existing active labels
                document.querySelectorAll('.active-label').forEach(label => label.remove());
                
                // Add active label to current active event
                if (data.activeEventIndex >= 0) {
                    const eventDiv = document.querySelector(`[data-event-index="${data.activeEventIndex}"]`);
                    if (eventDiv) {
                        const controls = eventDiv.querySelector('.event-controls');
                        const activeLabel = document.createElement('div');
                        activeLabel.className = 'active-label';
                        activeLabel.textContent = 'Active';
                        controls.insertBefore(activeLabel, controls.firstChild);
                    }
                }
            }
            
            // Update toggle button and global state
            if (data.enabled !== undefined) {
                globalState.enabled = data.enabled;
                const toggleButton = document.getElementById('toggleButton');
                toggleButton.textContent = data.enabled ? 'Enabled' : 'Disabled';
                toggleButton.className = data.enabled ? 'button-enabled' : 'button-disabled';
            }
            
            // Update mode button
            if (data.autoMode !== undefined) {
                const modeButton = document.getElementById('modeButton');
                modeButton.className = data.autoMode ? 'button-auto' : 'button-manual';
            }
            
            // Update global settings
            if (data.maxTemp !== undefined) {
                document.getElementById('maxTemp').value = data.maxTemp;
            }
            if (data.timezone !== undefined) {
                document.getElementById('timezone').value = data.timezone || 'America/Los_Angeles';
                // Update clock immediately when timezone changes
                updateClock();
            }
            
            // Update current temperature
            if (data.currentTempF !== undefined && data.currentTempC !== undefined) {
                const tempF = parseFloat(data.currentTempF);
                const tempC = parseFloat(data.currentTempC);
                if (!isNaN(tempF) && !isNaN(tempC)) {
                    document.getElementById('currentTempF').textContent = tempF.toFixed(1);
                    document.getElementById('currentTempC').textContent = tempC.toFixed(1);
                }
            }

            // Update overTemp state
            if (data.overTemp !== undefined) {
                globalState.overTemp = data.overTemp;
                const overTempButton = document.getElementById('overTempButton');
                overTempButton.textContent = data.overTemp ? 'True' : 'False';
                overTempButton.className = data.overTemp ? 'button-true' : 'button-false';
                
                // Update timestamp if provided
                if (data.overTempTimestamp !== undefined) {
                    document.getElementById('overTempTimestamp').textContent = data.overTemp ? data.overTempTimestamp : '';
                }
            }
        }
        
        function updateEventList(events) {
            const eventList = document.getElementById('eventList');
            const existingItems = eventList.getElementsByClassName('event-item');
            
            // Update currentSchedules array
            currentSchedules = events;
            
            // Check if events have changed
            const eventsChanged = events.length !== existingItems.length || 
                                events.some((event, index) => {
                                    const item = existingItems[index];
                                    return !item || 
                                           item.querySelector('.event-time').textContent !== `(${event.triggerTime})` ||
                                           item.querySelector('.event-intensity').textContent !== `(${event.lightIntensity}/255 ~${Math.round((event.lightIntensity / 255) * 100)}%)` ||
                                           item.querySelector('.button-enabled, .button-disabled').className !== (event.enabled ? 'button-enabled' : 'button-disabled');
                                });

            if (eventsChanged) {
                // Rebuild the entire list if events have changed
                eventList.innerHTML = '';
                events.forEach((event, index) => {
                    if (!event.enabled) return; // Skip disabled events
                    
                    const eventItem = document.createElement('div');
                    eventItem.className = 'event-item';
                    eventItem.setAttribute('data-event-index', index);
                    
                    const maxIntensity = globalState?.maxIntensity || 255;
                    const percentage = Math.round((event.lightIntensity / 255) * 100);
                    const intensityText = event.lightIntensity > maxIntensity ? 
                        `(${event.lightIntensity}/255 ~${percentage}% (limited to ${maxIntensity}))` : 
                        `(${event.lightIntensity}/255 ~${percentage}%)`;
                    
                    eventItem.innerHTML = `
                        <span class="event-time">(${event.triggerTime})</span>
                        <span class="event-intensity">${intensityText}</span>
                        <span class="event-countdown" id="countdown-${index}" data-trigger-time="${event.triggerTime}">Calculating...</span>
                        <div class="event-controls">
                            <button class="${event.enabled ? 'button-enabled' : 'button-disabled'}" onclick="toggleEvent(${index})">${event.enabled ? 'Enabled' : 'Disabled'}</button>
                            <button class="button-delete" onclick="deleteEvent(${index})">Delete</button>
                        </div>
                    `;
                    
                    eventList.appendChild(eventItem);
                    
                    if (event.enabled) {
                        updateCountdown(index, event.triggerTime);
                    }
                });
            }

            // Update active label position without rebuilding
            events.forEach((event, index) => {
                if (!event.enabled) return; // Skip disabled events
                
                const eventItem = eventList.querySelector(`[data-event-index="${index}"]`);
                if (!eventItem) return;
                
                const existingActive = eventItem.querySelector('.active-label');
                const shouldBeActive = index === globalState.activeEventIndex;

                if (shouldBeActive && !existingActive) {
                    // Add active label if needed
                    const activeLabel = document.createElement('div');
                    activeLabel.className = 'active-label';
                    activeLabel.textContent = 'Active';
                    eventItem.querySelector('.event-controls').insertBefore(activeLabel, eventItem.querySelector('.event-controls').firstChild);
                } else if (!shouldBeActive && existingActive) {
                    // Remove active label if not needed
                    existingActive.remove();
                }
            });

            // Update countdowns
            updateAllCountdowns();
        }
        
        function updateCountdown(index, triggerTime) {
            const countdownElement = document.getElementById(`countdown-${index}`);
            if (!countdownElement || !triggerTime) return;
            
            try {
                // Remove parentheses if present
                triggerTime = triggerTime.replace(/[()]/g, '');
                
                const [hours, minutes, seconds] = triggerTime.split(':').map(Number);
                if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) {
                    console.error('Invalid time format:', triggerTime);
                    return;
                }
                
                const now = new Date();
                const target = new Date(now);
                target.setHours(hours, minutes, seconds, 0);
                
                // If the target time is in the past, set it to tomorrow
                if (target < now) {
                    target.setDate(target.getDate() + 1);
                }
                
                const diff = target - now;
                const h = Math.floor(diff / 3600000);
                const m = Math.floor((diff % 3600000) / 60000);
                const s = Math.floor((diff % 60000) / 1000);
                
                countdownElement.textContent = `(Triggers in ${h}h ${m}m ${s}s)`;
            } catch (e) {
                console.error('Error updating countdown:', e);
            }
        }
        
        function updateAllCountdowns() {
            const events = document.querySelectorAll('.event-item');
            events.forEach(eventDiv => {
                const timeSpan = eventDiv.querySelector('.event-time');
                const index = eventDiv.getAttribute('data-event-index');
                if (timeSpan && timeSpan.textContent && index !== null) {
                    updateCountdown(parseInt(index), timeSpan.textContent);
                }
            });
        }
        
        function updateMaxIntensityDisplay() {
            const display = document.getElementById('maxIntensityDisplay');
            if (display) {
                display.textContent = globalState.maxIntensity;
            }
        }

        function updateGlobalSettings() {
            const maxIntensity = parseInt(document.getElementById('maxIntensity').value);
            const maxTemp = parseInt(document.getElementById('maxTemp').value);
            const timezone = document.getElementById('timezone').value;

            if (isNaN(maxIntensity) || maxIntensity < 0 || maxIntensity > 255) {
                alert('Maximum Intensity must be between 0 and 255');
                return;
            }

            if (isNaN(maxTemp) || maxTemp < 0 || maxTemp > 120) {
                alert('Maximum Temperature must be between 0 and 120');
                return;
            }

            fetch('/api/lighting/global', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    maxIntensity,
                    maxTemp,
                    timezone
                })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    globalState.maxIntensity = maxIntensity;
                    globalState.maxTemp = maxTemp;
                    globalState.timezone = timezone;
                    updateMaxIntensityDisplay();
                    updateClock();
                } else {
                    alert('Failed to update settings: ' + (data.error || 'Unknown error'));
                }
            })
            .catch(error => {
                console.error('Error:', error);
                alert('Failed to update settings');
            });
        }
        
        function toggleOverTemp() {
            const currentState = document.getElementById('overTempButton').textContent === 'True';
            const newState = !currentState;
            
            fetch('/api/lighting/overtemp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    overTemp: newState,
                    timestamp: newState ? new Date().toLocaleString() : ''
                })
            })
            .then(response => {
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    const overTempButton = document.getElementById('overTempButton');
                    overTempButton.textContent = newState ? 'True' : 'False';
                    overTempButton.className = newState ? 'button-true' : 'button-false';
                    document.getElementById('overTempTimestamp').textContent = newState ? data.timestamp : '';
                }
            })
            .catch(error => {
                console.error('Error toggling over temperature:', error);
            });
        }
        
        function fetchSchedule() {
            fetch('/api/lighting/schedules')
                .then(response => response.json())
                .then(data => {
                    if (data && data.events) {
                        updateEventList(data.events);
                    }
                })
                .catch(error => console.error('Error fetching schedules:', error));
        }
        
        function addEvent() {
            const time = document.getElementById('triggerTime').value;
            const intensity = parseInt(document.getElementById('lightIntensity').value);
            
            if (!time.match(/^[0-9]{2}:[0-9]{2}:[0-9]{2}$/)) {
                alert('Please enter time in HH:MM:SS format');
                return;
            }
            
            if (intensity < 0 || intensity > 255) {
                alert(`Intensity must be between 0 and 255 (Maximum Intensity set to ${globalState.maxIntensity})`);
                return;
            }
            
            fetch('/api/lighting/schedule', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    triggerTime: time,
                    lightIntensity: intensity,
                    enabled: true
                })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    // Clear input fields
                    document.getElementById('triggerTime').value = '';
                    document.getElementById('lightIntensity').value = '255';
                    // Refresh event list
                    fetchSchedule();
                } else {
                    alert('Failed to add event');
                }
            })
            .catch(error => {
                console.error('Error adding event:', error);
                alert('Error adding event');
            });
        }
        
        function deleteEvent(index) {
            fetch(`/api/lighting/schedule/${index}`, {
                method: 'DELETE'
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    fetchSchedule();
                } else {
                    alert('Failed to delete event');
                }
            })
            .catch(error => {
                console.error('Error deleting event:', error);
                alert('Error deleting event');
            });
        }
        
        function toggleEvent(index) {
            fetch(`/api/lighting/schedule/${index}/toggle`, {
                method: 'POST'
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    fetchSchedule();
                } else {
                    alert('Failed to toggle event');
                }
            })
            .catch(error => {
                console.error('Error toggling event:', error);
                alert('Error toggling event');
            });
        }
        
        function setManualIntensity() {
            const intensityInput = document.getElementById('intensityValue');
            const intensity = parseInt(intensityInput.value);
            
            if (intensity < 0 || intensity > 255) {
                alert('Please enter a valid intensity value between 0 and 255');
                return;
            }
            
            console.log('Sending manual intensity:', intensity);
            fetch('/api/lighting/manual', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    intensity: intensity
                })
            })
            .then(response => response.json())
            .then(data => {
                console.log('Received response:', data);
                if (data.success) {
                    // Update the input to match the actual value
                    intensityInput.value = data.intensity;
                    currentIntensity = data.intensity;  // Update the global currentIntensity
                    console.log('Updated currentIntensity to:', currentIntensity);
                } else {
                    console.error('Failed to set manual intensity:', data.error);
                    alert(data.error || 'Failed to set manual intensity');
                }
            })
            .catch(error => {
                console.error('Error setting manual intensity:', error);
                alert('Error setting manual intensity');
            });
        }
        
        function toggleMode() {
            const newState = !isManualMode;
            fetch('/api/lighting/mode', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    autoMode: !newState
                })
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    isManualMode = !data.autoMode;  // Use server response to set state
                    const modeButton = document.getElementById('modeButton');
                    
                    modeButton.textContent = isManualMode ? 'Manual Mode' : 'Auto Mode';
                    modeButton.className = isManualMode ? 'button-manual' : 'button-auto';
                } else {
                    console.error('Mode toggle failed:', data.error);
                }
            })
            .catch(error => {
                console.error('Error toggling mode:', error);
            });
        }
        
        function updateLightSensorError() {
            const lightSensorButton = document.getElementById('lightSensorButton');
            const lightSensorError = document.getElementById('lightSensorError');
            
            // Get current active event from currentSchedules array
            const activeEvent = globalState.activeEventIndex >= 0 ? 
                currentSchedules[globalState.activeEventIndex] : null;
            
            const scheduledIntensity = activeEvent ? activeEvent.lightIntensity : 0;
            const lightDetected = globalState.lightSensorState;
            
            if ((scheduledIntensity > 0 && !lightDetected) || 
                (scheduledIntensity === 0 && lightDetected)) {
                lightSensorError.textContent = "Scheduled lighting/sensor mismatch";
            } else {
                lightSensorError.textContent = "";
            }
        }

        function toggleLightSensor() {
            const button = document.getElementById('lightSensorButton');
            globalState.lightSensorState = !globalState.lightSensorState;
            
            if (globalState.lightSensorState) {
                button.textContent = 'Light Detected';
                button.className = 'button-light-detected';
            } else {
                button.textContent = 'No Light Detected';
                button.className = 'button-no-light';
            }
            
            updateLightSensorError();
        }
        
        function handleIntensityKeyPress(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                setManualIntensity();
            }
        }
        
        function toggleLighting() {
            const enabled = !globalState.enabled;
            fetch('/api/lighting/toggle', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ enabled })
            })
            .then(response => response.json())
            .then(data => {
                if (data && data.success) {
                    // Update local state
                    globalState.enabled = enabled;
                    const toggleButton = document.getElementById('toggleButton');
                    toggleButton.textContent = enabled ? 'Enabled' : 'Disabled';
                    toggleButton.className = enabled ? 'button-enabled' : 'button-disabled';
                } else {
                    alert('Failed to update lighting state: ' + (data?.error || 'Unknown error'));
                }
            })
            .catch(error => {
                console.error('Error:', error);
                alert('Failed to update lighting state');
            });
        }
        
        // Start WebSocket connection and initial schedule fetch
        connectWebSocket();
        fetchSchedule();
        
        // Update countdowns every second
        setInterval(updateAllCountdowns, 1000);
        
        // Update clock every second
        setInterval(updateClock, 1000);
        
        // Request status updates every 2 seconds instead of every second
        setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({type: 'get_status'}));
            }
        }, 2000);
    </script>
</body>
</html>
)rawliteral";
        
        client.println("HTTP/1.1 200 OK");
        client.println("Content-Type: text/html");
        client.println("Connection: close");
        client.println();
        client.println(html);
    }
    else if (request.indexOf("GET /") >= 0) {
        // Serve the root page with device info only
        String html = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
    <title>Device Information</title>
    <meta charset='UTF-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1'>
    <meta http-equiv='Content-Type' content='text/html; charset=UTF-8'>
    <style>
        body { font-family: Arial; margin: 20px; }
        .device-info {
            margin: 20px 0;
            padding: 15px;
            border: 1px solid #ddd;
            border-radius: 5px;
            background: #333;
        }
        .device-info h2 {
            margin-top: 0;
            color: #333;
        }
        .device-info p {
            margin: 10px 0;
            color: #666;
        }
        .control-button {
            display: inline-block;
            background: #4CAF50;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            margin-top: 20px;
            transition: background 0.3s;
        }
        .control-button:hover {
            background: #45a049;
        }
    </style>
</head>
<body>
    <div class='container'>
        <div class='device-info'>
            <h2>Device Information</h2>
            <p>Temperature: <span id='temperature'>--</span>&#176;F</p>
            <p>Humidity: <span id='humidity'>--</span>%</p>
            <p>IP Address: <span id='ip'>--</span></p>
            <p>Current Time: <span id='currentTime'>--</span></p>
            <p>Uptime: <span id='uptime'>--</span></p>
        </div>
        <a href='/lighting' class='control-button'>Lighting Control</a>
    </div>

    <script>
        function updateDeviceInfo() {
            fetch('/api/device/info')
                .then(response => response.json())
                .then(data => {
                    if (data.temperature !== undefined) {
                        document.getElementById('temperature').textContent = data.temperature.toFixed(1);
                    }
                    if (data.humidity !== undefined) {
                        document.getElementById('humidity').textContent = data.humidity.toFixed(1);
                    }
                    if (data.ip) {
                        document.getElementById('ip').textContent = data.ip;
                    }
                    if (data.currentTime) {
                        document.getElementById('currentTime').textContent = data.currentTime;
                    }
                    if (data.uptime) {
                        document.getElementById('uptime').textContent = data.uptime;
                    }
                })
                .catch(error => {
                    console.error('Error fetching device info:', error);
                });
        }

        // Update device info every second
        updateDeviceInfo();
        setInterval(updateDeviceInfo, 1000);
    </script>
</body>
</html>
)rawliteral";
        
        client.println("HTTP/1.1 200 OK");
        client.println("Content-Type: text/html");
        client.println("Connection: close");
        client.println();
        client.println(html);
    }
    else if (request.indexOf("POST /api/lighting/toggle") >= 0) {
        // Skip headers
        while (client.available()) {
            if (client.read() == '\n') {
                if (client.peek() == '\r') {
                    client.read(); // Skip \r
                    if (client.peek() == '\n') {
                        client.read(); // Skip \n
                        break; // Found end of headers
                    }
                }
            }
        }

        // Read the JSON body
        String body = "";
        while (client.available()) {
            body += (char)client.read();
        }
        
        Serial.println("[Toggle] Received request body: " + body);
        
        // Skip HTTP headers if present
        int jsonStart = body.indexOf("{");
        if (jsonStart >= 0) {
            body = body.substring(jsonStart);
        }
        
        StaticJsonDocument<200> doc;
        DeserializationError error = deserializeJson(doc, body);
        
        if (!error && doc.containsKey("enabled")) {
            // Update both global state and lighting state
            lightingEnabled = doc["enabled"];
            globalState.enabled = lightingEnabled;
            
            Serial.printf("[Toggle] Setting enabled state to: %d\n", lightingEnabled);
            
            // Save to EEPROM
            saveSchedulesToEEPROM();
            
            // Update lighting output
            updateLighting();
            
            // Send WebSocket update to all connected clients
            if (ws.connectedClients() > 0) {
                String status = getLightingStatusJSON();
                ws.broadcastTXT(status);
                //Serial.println("[WebSocket] Broadcast lighting status update: " + status);
            }
            
            // Send success response
            client.println("HTTP/1.1 200 OK");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":true}");
        } else {
            Serial.println("[Toggle] Invalid request or JSON error");
            // Send error response
            client.println("HTTP/1.1 400 Bad Request");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"Invalid request\"}");
        }
    }
    else if (request.indexOf("POST /api/lighting/schedule/") >= 0 && request.indexOf("/toggle") >= 0) {
        // Extract index from URL
        int startPos = request.indexOf("schedule/") + 9;
        int endPos = request.indexOf("/toggle", startPos);
        if (endPos == -1) {
            client.println("HTTP/1.1 400 Bad Request");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"Invalid URL format\"}");
            return;
        }
        
        String indexStr = request.substring(startPos, endPos);
        int index = indexStr.toInt();
        
        // Skip headers
        while (client.available()) {
            if (client.read() == '\n') {
                if (client.peek() == '\r') {
                    client.read(); // Skip \r
                    if (client.peek() == '\n') {
                        client.read(); // Skip \n
                        break; // Found end of headers
                    }
                }
            }
        }
        
        if (index >= 0 && index < MAX_SCHEDULES) {
            // Toggle the enabled state
            events[index].enabled = !events[index].enabled;
            
            saveSchedulesToEEPROM();
            updateLighting();
            
            client.println("HTTP/1.1 200 OK");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":true}");
        } else {
            client.println("HTTP/1.1 400 Bad Request");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"Invalid index\"}");
        }
    }
    else if (request.indexOf("POST /api/lighting/schedule") >= 0) {
        // Wait for complete request body
        String body = "";
        while (client.available()) {
            char c = client.read();
            body += c;
        }
        
        // Skip HTTP headers if present
        int jsonStart = body.indexOf("{");
        if (jsonStart >= 0) {
            body = body.substring(jsonStart);
        }
        
        StaticJsonDocument<1024> doc;
        DeserializationError error = deserializeJson(doc, body);
        
        if (error) {
            client.println("HTTP/1.1 400 Bad Request");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"Invalid JSON\"}");
            return;
        }
        
        // Check if all slots are full
        bool allSlotsFull = true;
        for (int i = 0; i < MAX_SCHEDULES; i++) {
            if (!events[i].enabled || !events[i].triggerTime[0]) {
                allSlotsFull = false;
                break;
            }
        }
        
        if (allSlotsFull) {
            client.println("HTTP/1.1 400 Bad Request");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"All event slots are full\"}");
            return;
        }
        
        // Find insertion point and shift events
        int insertIndex = -1;
        for (int i = 0; i < MAX_SCHEDULES; i++) {
            if (!events[i].enabled || !events[i].triggerTime[0]) {
                // Found an empty slot
                insertIndex = i;
                break;
            }
            
            // Compare times to find where to insert
            if (strcmp(doc["triggerTime"].as<const char*>(), events[i].triggerTime) < 0) {
                insertIndex = i;
                break;
            }
        }
        
        if (insertIndex == -1) {
            // Should never happen due to allSlotsFull check
            client.println("HTTP/1.1 500 Internal Server Error");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"Failed to find insertion point\"}");
            return;
        }
        
        // Shift events down to make room
        for (int i = MAX_SCHEDULES - 1; i > insertIndex; i--) {
            if (events[i-1].enabled) {
                events[i] = events[i-1];
            }
        }
        
        // Insert new event
        strncpy(events[insertIndex].triggerTime, doc["triggerTime"].as<const char*>(), 9);
        events[insertIndex].lightIntensity = doc["lightIntensity"];
        events[insertIndex].enabled = true;
        
        // Update global state
        memcpy(globalState.events, events, sizeof(events));
        
        // Save to EEPROM
        saveSchedulesToEEPROM();
        
        client.println("HTTP/1.1 200 OK");
        client.println("Content-Type: application/json");
        client.println("Connection: close");
        client.println();
        client.println("{\"success\":true}");
    }
    else if (request.indexOf("DELETE /api/lighting/schedule/") >= 0) {
        // Extract index from URL
        int index = request.substring(request.indexOf("schedule/") + 9).toInt();
        
        if (index >= 0 && index < MAX_SCHEDULES) {
            // Clear all event data
            memset(&events[index], 0, sizeof(LightingEvent));
            events[index].enabled = false;
            events[index].lightIntensity = 0;
            strcpy(events[index].triggerTime, "");
            
            saveSchedulesToEEPROM();
            
            // Update lighting state after removing event
            updateLighting();
            
            client.println("HTTP/1.1 200 OK");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":true}");
        } else {
            client.println("HTTP/1.1 400 Bad Request");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"Invalid index\"}");
        }
    }
    else if (request.indexOf("POST /api/lighting/mode") >= 0) {
        // Skip headers
        while (client.available()) {
            if (client.read() == '\n') {
                if (client.peek() == '\r') {
                    client.read(); // Skip \r
                    if (client.peek() == '\n') {
                        client.read(); // Skip \n
                        break; // Found end of headers
                    }
                }
            }
        }

        // Read the JSON body
        String body = "";
        while (client.available()) {
            body += (char)client.read();
        }
        
        Serial.println("[Mode] Received request body: " + body);
        
        // Skip HTTP headers if present
        int jsonStart = body.indexOf("{");
        if (jsonStart >= 0) {
            body = body.substring(jsonStart);
        }
        
        StaticJsonDocument<200> doc;
        DeserializationError error = deserializeJson(doc, body);
        
        if (!error && doc.containsKey("autoMode")) {
            // Update both global state and lighting mode
            globalState.autoMode = doc["autoMode"];
            lightingMode = globalState.autoMode ? LIGHTING_MODE_AUTO : LIGHTING_MODE_MANUAL;
            
            Serial.printf("[Mode] Setting auto mode to: %d\n", globalState.autoMode);
            
            // Save to EEPROM
            saveSchedulesToEEPROM();
            
            // Update lighting output
            updateLighting();
            
            // Send WebSocket update to all connected clients
            if (ws.connectedClients() > 0) {
                String status = getLightingStatusJSON();
                ws.broadcastTXT(status);
                //Serial.println("[WebSocket] Broadcast lighting status update: " + status);
            }
            
            // Send success response
            client.println("HTTP/1.1 200 OK");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":true}");
        } else {
            Serial.println("[Mode] Invalid request or JSON error");
            // Send error response
            client.println("HTTP/1.1 400 Bad Request");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"Invalid request\"}");
        }
    }
    else if (request.indexOf("POST /api/lighting/manual") >= 0) {
        // Skip headers
        while (client.available()) {
            if (client.read() == '\n') {
                if (client.peek() == '\r') {
                    client.read(); // Skip \r
                    if (client.peek() == '\n') {
                        client.read(); // Skip \n
                        break; // Found end of headers
                    }
                }
            }
        }

        // Read the JSON body
        String body = "";
        while (client.available()) {
            body += (char)client.read();
        }
        
        Serial.println("[Manual] Received request body: " + body);
        
        // Skip HTTP headers if present
        int jsonStart = body.indexOf("{");
        if (jsonStart >= 0) {
            body = body.substring(jsonStart);
        }
        
        StaticJsonDocument<200> doc;
        DeserializationError error = deserializeJson(doc, body);
        
        if (!error && doc.containsKey("intensity")) {
            int intensity = doc["intensity"];
            
            if (intensity >= 0 && intensity <= 255) {
                // Only update intensity if in manual mode
                if (lightingMode == LIGHTING_MODE_MANUAL) {
                    // Apply max intensity limit
                    intensity = (uint8_t)min((uint8_t)intensity, globalState.maxIntensity);
                    currentIntensity = intensity;  // Update the global currentIntensity
                    globalState.lightIntensity = intensity;  // Update the global state
                    
                    // Update PWM output immediately
                    ledc_set_duty(LEDC_LOW_SPEED_MODE, PWM_CHANNEL, currentIntensity);
                    ledc_update_duty(LEDC_LOW_SPEED_MODE, PWM_CHANNEL);
                    
                    // Send WebSocket update to all connected clients
                    if (ws.connectedClients() > 0) {
                        String status = getLightingStatusJSON();
                        ws.broadcastTXT(status);
                    }
                    
                    // Send success response
                    client.println("HTTP/1.1 200 OK");
                    client.println("Content-Type: application/json");
                    client.println("Connection: close");
                    client.println();
                    client.println("{\"success\":true,\"intensity\":" + String(intensity) + "}");
                } else {
                    // Send error response if not in manual mode
                    client.println("HTTP/1.1 400 Bad Request");
                    client.println("Content-Type: application/json");
                    client.println("Connection: close");
                    client.println();
                    client.println("{\"success\":false,\"error\":\"System must be in manual mode to set intensity\"}");
                }
            } else {
                // Send error response for invalid intensity
                client.println("HTTP/1.1 400 Bad Request");
                client.println("Content-Type: application/json");
                client.println("Connection: close");
                client.println();
                client.println("{\"success\":false,\"error\":\"Intensity must be between 0 and 255\"}");
            }
        } else {
            // Send error response for JSON parsing error
            client.println("HTTP/1.1 400 Bad Request");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"Invalid JSON format\"}");
        }
    }
    else if (request.indexOf("POST /api/lighting/global") >= 0) {
        // Skip headers
        while (client.available()) {
            if (client.read() == '\n') {
                if (client.peek() == '\r') {
                    client.read(); // Skip \r
                    if (client.peek() == '\n') {
                        client.read(); // Skip \n
                        break; // Found end of headers
                    }
                }
            }
        }

        // Read the JSON body
        String body = "";
        while (client.available()) {
            body += (char)client.read();
        }
        
        Serial.println("[Global] Received request body: " + body);
        
        // Skip HTTP headers if present
        int jsonStart = body.indexOf("{");
        if (jsonStart >= 0) {
            body = body.substring(jsonStart);
        }
        
        StaticJsonDocument<200> doc;
        DeserializationError error = deserializeJson(doc, body);
        
        if (!error) {
            bool changed = false;
            
            // Update maxIntensity if provided
            if (doc.containsKey("maxIntensity")) {
                uint8_t newMaxIntensity = doc["maxIntensity"];
                if (newMaxIntensity >= 0 && newMaxIntensity <= 255) {
                    globalState.maxIntensity = newMaxIntensity;
                    changed = true;
                    Serial.printf("[Global] Setting maxIntensity to: %d\n", newMaxIntensity);
                }
            }
            
            // Update tempThreshold if provided
            if (doc.containsKey("tempThreshold")) {
                uint8_t newTempThreshold = doc["tempThreshold"];
                globalState.tempThreshold = newTempThreshold;
                changed = true;
                Serial.printf("[Global] Setting tempThreshold to: %d\n", newTempThreshold);
            }
            
            // Update timezone if provided
            if (doc.containsKey("timezone")) {
                const char* newTimezone = doc["timezone"];
                if (strlen(newTimezone) < sizeof(globalState.timezone)) {
                    strncpy(globalState.timezone, newTimezone, sizeof(globalState.timezone) - 1);
                    globalState.timezone[sizeof(globalState.timezone) - 1] = '\0';
                    changed = true;
                    Serial.printf("[Global] Setting timezone to: %s\n", newTimezone);
                }
            }
            
            if (changed) {
                // Save to EEPROM
                saveSchedulesToEEPROM();
                
                // Send WebSocket update to all connected clients
                if (ws.connectedClients() > 0) {
                    String status = getLightingStatusJSON();
                    ws.broadcastTXT(status);
                    //Serial.println("[WebSocket] Broadcast lighting status update: " + status);
                }
                
                // Send success response
                client.println("HTTP/1.1 200 OK");
                client.println("Content-Type: application/json");
                client.println("Connection: close");
                client.println();
                client.println("{\"success\":true}");
            } else {
                // Send error response if no valid changes
                client.println("HTTP/1.1 400 Bad Request");
                client.println("Content-Type: application/json");
                client.println("Connection: close");
                client.println();
                client.println("{\"success\":false,\"error\":\"No valid changes\"}");
            }
        } else {
            Serial.println("[Global] Invalid request or JSON error");
            // Send error response
            client.println("HTTP/1.1 400 Bad Request");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"Invalid request\"}");
        }
    }
    else if (request.indexOf("POST /api/lighting/overtemp") >= 0) {
        // Skip headers
        while (client.available()) {
            if (client.read() == '\n') {
                if (client.peek() == '\r') {
                    client.read(); // Skip \r
                    if (client.peek() == '\n') {
                        client.read(); // Skip \n
                        break; // Found end of headers
                    }
                }
            }
        }

        // Read the JSON body
        String body = "";
        while (client.available()) {
            body += (char)client.read();
        }
        
        Serial.println("[OverTemp] Received request body: " + body);
        
        // Skip HTTP headers if present
        int jsonStart = body.indexOf("{");
        if (jsonStart >= 0) {
            body = body.substring(jsonStart);
        }
        
        StaticJsonDocument<200> doc;
        DeserializationError error = deserializeJson(doc, body);
        
        if (!error && doc.containsKey("overTemp")) {
            // Update global state
            globalState.overTemp = doc["overTemp"];
            
            // Update timestamp if provided
            if (doc.containsKey("timestamp")) {
                strncpy(globalState.overTempTimestamp, doc["timestamp"] | "", sizeof(globalState.overTempTimestamp) - 1);
                globalState.overTempTimestamp[sizeof(globalState.overTempTimestamp) - 1] = '\0';
            }
            
            Serial.printf("[OverTemp] Setting overTemp to: %d\n", globalState.overTemp);
            
            // Save to EEPROM
            saveSchedulesToEEPROM();
            
            // Send WebSocket update to all connected clients
            if (ws.connectedClients() > 0) {
                String status = getLightingStatusJSON();
                ws.broadcastTXT(status);
                //Serial.println("[WebSocket] Broadcast lighting status update: " + status);
            }
            
            // Send success response with timestamp
            client.println("HTTP/1.1 200 OK");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            
            StaticJsonDocument<200> response;
            response["success"] = true;
            response["timestamp"] = globalState.overTempTimestamp;
            String responseStr;
            serializeJson(response, responseStr);
            client.println(responseStr);
        } else {
            Serial.println("[OverTemp] Invalid request or JSON error");
            // Send error response
            client.println("HTTP/1.1 400 Bad Request");
            client.println("Content-Type: application/json");
            client.println("Connection: close");
            client.println();
            client.println("{\"success\":false,\"error\":\"Invalid request\"}");
        }
    }
}

// Utility function implementations
String formatMillisToHMS(unsigned long ms) {
    unsigned long totalSec = ms / 1000UL;
    unsigned long hours = totalSec / 3600UL;
    unsigned long mins  = (totalSec % 3600UL) / 60UL;
    unsigned long secs  = totalSec % 60UL;

    char buf[16];
    snprintf(buf, sizeof(buf), "%02lu:%02lu:%02lu", hours, mins, secs);
    return String(buf);
}

String getCurrentTime() {
    struct tm timeinfo;
    if(!getLocalTime(&timeinfo)){
        return "Failed to obtain time";
    }
    char timeStringBuff[50];
    strftime(timeStringBuff, sizeof(timeStringBuff), "%H:%M:%S", &timeinfo);
    return String(timeStringBuff);
}

void handleWebSocketMessage(uint8_t num, uint8_t * payload, size_t length) {
    // Convert payload to string
    String message = "";
    for(int i = 0; i < length; i++) {
        message += (char)payload[i];
    }
    
    // Parse JSON
    StaticJsonDocument<200> doc;
    DeserializationError error = deserializeJson(doc, message);
    
    if (!error && doc.containsKey("type")) {
        const char* type = doc["type"];
        
        if (strcmp(type, "get_status") == 0) {
            // Send status without logging
            String status = getLightingStatusJSON();
            ws.sendTXT(num, status);
        }
        else if (strcmp(type, "set_intensity") == 0) {
            if (doc.containsKey("intensity")) {
                int intensity = doc["intensity"];
                if (intensity >= 0 && intensity <= 255) {
                    currentIntensity = intensity;
                    updateLighting();
                    //Serial.printf("[WebSocket] Set intensity to: %d\n", intensity);
                }
            }
        }
    }
}

#endif // LIGHTING_CONTROL_H 
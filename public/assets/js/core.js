// Undergrowth Node - Core JavaScript
// Contains shared functionality for safety state management, UI updates, and socket handling

// Global state
let currentSafetyState = {
    emergency_stop: false,
    normal_enable: true
};

/**
 * Initialize socket event listeners for safety state
 * @param {object} socket - Socket.io socket object
 */
function initializeSafetyListeners(socket) {
    // Initial state handling
    socket.on('initialState', (data) => {
        // Handle safety state - proper conversion of numeric values to boolean
        if (data && data.safetyStates) {
            // Convert number values to boolean for UI consistency
            currentSafetyState = {
                emergency_stop: data.safetyStates.emergency_stop === 1,
                normal_enable: data.safetyStates.normal_enable === 1
            };
            updateSafetyUI();
        } else if (data && data.safety) {
            currentSafetyState = data.safety;
            updateSafetyUI();
        }
        
        // Call custom handler if provided
        if (typeof onInitialState === 'function') {
            onInitialState(data);
        }
    });

    // Safety state updates
    socket.on('safetyStateUpdate', (data) => {
        currentSafetyState = data;
        updateSafetyUI();
    });

    // Emergency stop event
    socket.on('emergencyStop', () => {
        currentSafetyState.emergency_stop = true;
        updateSafetyUI();
    });

    // Clear emergency stop event
    socket.on('clearEmergencyStop', () => {
        currentSafetyState.emergency_stop = false;
        updateSafetyUI();
    });
}

/**
 * Update the UI based on current safety state
 */
function updateSafetyUI() {
    const emergencyButton = document.getElementById('emergencyButton');
    if (!emergencyButton) {
        return;
    }
    
    if (currentSafetyState.emergency_stop) {
        emergencyButton.textContent = 'Clear Emergency';
        emergencyButton.classList.add('emergency-active');
        document.body.style.backgroundColor = 'var(--error-color)';
    } else {
        emergencyButton.textContent = 'Emergency Stop';
        emergencyButton.classList.remove('emergency-active');
        document.body.style.backgroundColor = 'var(--bg-primary)';
    }
}

/**
 * Initialize emergency button click handler
 * @param {object} socket - Socket.io socket object
 */
function initializeEmergencyButton(socket) {
    const emergencyButton = document.getElementById('emergencyButton');
    if (emergencyButton) {
        emergencyButton.addEventListener('click', () => {
            if (emergencyButton.textContent === 'Emergency Stop') {
                socket.emit('emergencyStop');
            } else {
                socket.emit('clearEmergencyStop');
            }
        });
    }
}

/**
 * Format a date with the given timezone
 * @param {Date} date - Date object
 * @param {string} timezone - Timezone string
 * @param {boolean} includeDate - Whether to include the date
 * @param {boolean} use24Hour - Whether to use 24-hour format
 * @returns {string} Formatted date/time string
 */
function formatTimeWithTimezone(date, timezone, includeDate = false, use24Hour = true) {
    const options = {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: !use24Hour,
        timeZoneName: 'short'
    };
    
    if (includeDate) {
        options.month = 'long';
        options.day = 'numeric';
        options.year = 'numeric';
    }
    
    const formatter = new Intl.DateTimeFormat('en-US', options);
    return formatter.format(date);
}

/**
 * Toggle between manual and automatic PWM control mode
 * @param {object} socket - Socket.io socket object
 */
function togglePwmMode(socket) {
    const modeToggle = document.getElementById('modeToggle');
    if (!modeToggle) return;
    
    const automatic = modeToggle.checked;
    socket.emit('setMode', { automatic });
}

/**
 * Initialize PWM mode toggle controls
 * @param {object} socket - Socket.io socket object
 */
function initializePwmModeToggle(socket) {
    const modeToggle = document.getElementById('modeToggle');
    if (modeToggle) {
        modeToggle.addEventListener('change', () => togglePwmMode(socket));
    }
}

/**
 * Get timezone abbreviation from timezone
 * @param {Date} date - Date object
 * @param {string} timezone - Timezone string
 * @returns {string} Timezone abbreviation
 */
function getTimezoneAbbr(date, timezone) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'short'
    }).formatToParts(date).find(part => part.type === 'timeZoneName').value;
}

/**
 * Format a timezone string to display as "PDT (UTC-7)" format
 * @param {string} timezone - Timezone string (e.g. "America/Los_Angeles")
 * @returns {string} Formatted timezone (e.g. "PDT (UTC-7)")
 */
function formatTimezoneDisplay(timezone) {
    try {
        const date = new Date();
        
        // Get the abbreviation (e.g., "PDT")
        const abbr = getTimezoneAbbr(date, timezone);
        
        // Calculate the UTC offset
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            timeZoneName: 'longOffset'
        });
        
        // Extract the UTC offset from the formatted string
        const parts = formatter.formatToParts(date);
        const offsetPart = parts.find(part => part.type === 'timeZoneName');
        let offset = '';
        
        if (offsetPart) {
            // Extract just the UTC+X or UTC-X part
            const match = offsetPart.value.match(/GMT([+-]\d+)/);
            if (match && match[1]) {
                offset = `UTC${match[1]}`;
            }
        }
        
        return `${abbr} (${offset})`;
    } catch (error) {
        console.error('Error formatting timezone:', error);
        return timezone; // Return original if there's an error
    }
}

/**
 * Initialize the application when the DOM is ready
 * @param {object} socket - Socket.io socket object
 * @param {function} customInit - Optional custom initialization function
 */
function initializeApp(socket, customInit = null) {
    document.addEventListener('DOMContentLoaded', () => {
        // Initialize safety state
        updateSafetyUI();
        
        // Set up emergency button
        initializeEmergencyButton(socket);
        
        // Set up PWM mode toggle
        initializePwmModeToggle(socket);
        
        // Request initial state
        socket.emit('getInitialState');
        
        // Call custom initialization if provided
        if (customInit && typeof customInit === 'function') {
            customInit();
        }
    });
    
    // Initialize safety state listeners
    initializeSafetyListeners(socket);
}

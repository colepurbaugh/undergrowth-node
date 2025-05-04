#!/bin/bash
# Automation_Custom_Script.sh for undergrowth-node
# This script runs after first boot and performs all custom installation tasks

# Log to dietpi-automation_custom_script.log
exec &> >(tee -a /var/tmp/dietpi/logs/dietpi-automation_custom_script.log)

echo "Starting undergrowth-node installation..."

# Enable I2C interface
echo "Enabling I2C interface..."
/boot/dietpi/func/dietpi-set_hardware i2c enable || echo "Failed to enable I2C interface"

# Enable GPIO in config.txt if not already enabled
echo "Enabling GPIO in config.txt..."
if ! grep -q "^dtparam=gpio=on" /boot/config.txt; then
    echo "dtparam=gpio=on" >> /boot/config.txt
    echo "Added GPIO configuration to config.txt"
else
    echo "GPIO already enabled in config.txt"
fi

# Enable SPI in config.txt if not already enabled
echo "Enabling SPI in config.txt..."
if ! grep -q "^dtparam=spi=on" /boot/config.txt; then
    echo "dtparam=spi=on" >> /boot/config.txt
    echo "Added SPI configuration to config.txt"
else
    echo "SPI already enabled in config.txt"
fi

# Install required Python packages
echo "Installing Python dependencies..."
apt-get update
apt-get install -y python3-distutils python3-dev || echo "Failed to install Python dependencies"

# Install Pigpio C Library
echo "Installing Pigpio C Library..."
cd /tmp
wget https://github.com/joan2937/pigpio/archive/master.zip || { echo "Failed to download pigpio"; exit 1; }
unzip master.zip || { echo "Failed to extract pigpio"; exit 1; }
cd pigpio-master || { echo "Failed to change directory"; exit 1; }

# Modify the Makefile to skip Python installation if needed
# This is optional, but helps if Python setup continues to cause issues
sed -i 's/^PYINSTALL.*/PYINSTALL = :/' Makefile || echo "Failed to modify Makefile"

make || { echo "Failed to compile pigpio"; exit 1; }
make install || { echo "Failed to install pigpio"; exit 1; }

# Manually copy libraries and executables if make install fails
if [ ! -f "/usr/local/bin/pigpiod" ]; then
    echo "Manual installation of pigpio..."
    cp libpigpio.so* /usr/local/lib/ || echo "Failed to copy libpigpio.so"
    cp pigpiod /usr/local/bin/ || echo "Failed to copy pigpiod"
    cp pigs /usr/local/bin/ || echo "Failed to copy pigs"
    ldconfig || echo "Failed to run ldconfig"
fi

# Create socket directory for pigpio
echo "Creating socket directory for pigpio..."
mkdir -p /var/run/pigpio

# Start pigpio daemon with updated service definition
systemctl stop pigpiod || echo "Failed to stop pigpiod service"
echo "Creating pigpiod service..."
cat > /etc/systemd/system/pigpiod.service << EOL
[Unit]
Description=Pigpio daemon
After=network.target

[Service]
Type=forking
ExecStart=/usr/local/bin/pigpiod -l
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOL
systemctl daemon-reload
systemctl enable pigpiod || echo "Failed to enable pigpiod service"
systemctl start pigpiod || echo "Failed to start pigpiod service"

# Test pigpio socket connection
echo "Testing pigpio socket connection..."
sleep 2
pigs r 0
if [ $? -eq 0 ]; then
    echo "Pigpio is working correctly!"
else
    echo "Pigpio socket connection failed. Will retry after completing setup."
fi

# Install sqlite3 for database management
echo "Installing sqlite3..."
apt-get install -y sqlite3 || echo "Failed to install sqlite3"

# Install NVM
echo "Installing NVM..."
export NVM_DIR="/root/.nvm"
mkdir -p "$NVM_DIR"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash || { echo "Failed to install NVM"; exit 1; }
# Source NVM for this session
export NVM_DIR="/root/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"  # This loads nvm

# Install Node.js
echo "Installing Node.js..."
command -v nvm || { echo "NVM not installed properly"; exit 1; }
nvm install --lts || { echo "Failed to install Node.js"; exit 1; }
nvm use --lts || { echo "Failed to use LTS Node.js"; exit 1; }
NODE_VERSION=$(nvm current)
nvm alias default "$NODE_VERSION" || echo "Failed to set default Node.js version"

# Add NVM to root profile
echo 'export NVM_DIR="/root/.nvm"' >> /root/.bashrc
echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm' >> /root/.bashrc
echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion' >> /root/.bashrc

# Clone the repository
echo "Cloning undergrowth-node repository..."
mkdir -p /root/git
cd /root/git || { echo "Failed to create git directory"; exit 1; }
git clone https://github.com/colepurbaugh/undergrowth-node.git || { echo "Failed to clone repository"; exit 1; }
cd undergrowth-node || { echo "Failed to change directory"; exit 1; }

# Install npm dependencies
echo "Installing npm dependencies..."
npm install || { echo "Failed to install npm dependencies"; exit 1; }

# Create database directory if it doesn't exist
mkdir -p database

# Get actual Node.js path - double check to make sure it exists
NODE_PATH=$(which node)
if [ ! -f "$NODE_PATH" ]; then
    echo "Node.js executable not found. Using direct path."
    NODE_PATH="/root/.nvm/versions/node/$(ls -t /root/.nvm/versions/node/ | head -1)/bin/node"
fi
echo "Using Node.js at: $NODE_PATH"

# Setup systemd service
echo "Setting up systemd service..."
cat > /etc/systemd/system/ug-node.service << EOL
[Unit]
Description=Undergrowth Node.js Server
After=network.target pigpiod.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/git/undergrowth-node
ExecStart=${NODE_PATH} ug-node.js
Environment=NODE_ENV=production
Environment=PIGPIO_ADDR=localhost
Environment=PATH=/root/.nvm/versions/node/$(ls -t /root/.nvm/versions/node/ | head -1)/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=ug-node

[Install]
WantedBy=multi-user.target
EOL

# Make node.js able to bind to port 80
echo "Setting capabilities for Node.js..."
setcap 'cap_net_bind_service=+ep' "$NODE_PATH" || echo "Failed to set capabilities"

# Add user to necessary groups
echo "Adding user to required groups..."
usermod -a -G gpio,i2c,spi,kmem root || echo "Failed to add user to groups"

# Enable and start the service
echo "Enabling and starting ug-node service..."
systemctl daemon-reload
systemctl enable ug-node
systemctl start ug-node

# Final pigpio test to verify it's working
echo "Final pigpio test..."
pigs r 0
if [ $? -eq 0 ]; then
    echo "Pigpio is working correctly!"
else
    echo "Pigpio still not working, manual troubleshooting may be needed."
    echo "Try running: systemctl restart pigpiod"
    echo "Then test with: pigs r 0"
fi

echo "Undergrowth node installation completed!" 
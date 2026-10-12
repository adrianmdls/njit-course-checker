FROM ubuntu:24.04

# Install Python and required tools
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Create virtual environment and install dependencies
COPY requirements.txt .
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# Use virtual environment by default
ENV PATH="/opt/venv/bin:$PATH"

# Copy the application source code
COPY src/ ./src/

# Set default check interval to 10 minutes
ENV CHECK_INTERVAL=600

# Start the automated checker
CMD ["python", "-u", "src/checker.py"]
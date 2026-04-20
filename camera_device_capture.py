#!/usr/bin/env python3
"""
CAMERA SENSOR CAPTURE SCRIPT (Raspberry Pi / Device)

This script captures frames from a USB camera connected to a Raspberry Pi, 
device, or Linux system and uploads them to the Sensor Integration System server.

Installation:
    sudo apt-get update
    sudo apt-get install python3-opencv python3-pip python3-requests
    pip3 install opencv-python requests

Configuration:
    Edit the CONFIG section below with your server details

Running as a service (systemd):
    1. Copy this script to /opt/camera_sensor/
    2. Copy systemd service file: sudo cp camera_sensor.service /etc/systemd/system/
    3. Enable service: sudo systemctl enable camera_sensor
    4. Start service: sudo systemctl start camera_sensor
    5. Monitor logs: sudo journalctl -u camera_sensor -f
"""

import cv2
import base64
import requests
import json
import time
import os
import sys
import logging
from datetime import datetime
from threading import Thread, Event
import signal

# ============================================================
# CONFIGURATION
# ============================================================

CONFIG = {
    # Server Details
    'SERVER_URL': 'http://localhost:3001',
    'DEVICE_ID': 'camera_pi_001',
    'JWT_TOKEN': 'YOUR_JWT_TOKEN_HERE',  # Get from login
    
    # Camera Settings
    'CAMERA_INDEX': 0,  # 0 for default, use 1+ if multiple cameras
    'FRAME_WIDTH': 1280,
    'FRAME_HEIGHT': 720,
    'FPS': 15,
    
    # Capture Settings
    'CAPTURE_INTERVAL': 10,  # seconds between uploads
    'MOTION_DETECTION': True,  # Only upload if motion detected
    'MOTION_THRESHOLD': 5000,  # Pixel area that constitutes motion (lower = more sensitive)
    'QUALITY': 80,  # JPEG quality 1-100
    
    # Image Compression
    'MAX_IMAGE_SIZE': 2 * 1024 * 1024,  # 2MB max
    'DEDUPLICATION': True,  # Skip duplicate frames
    
    # Retry Settings
    'MAX_RETRIES': 3,
    'RETRY_DELAY': 5,  # seconds
    
    # Logging
    'LOG_FILE': '/var/log/camera_sensor.log',
    'LOG_LEVEL': 'INFO',
}

# ============================================================
# LOGGING SETUP
# ============================================================

def setup_logging():
    log_dir = os.path.dirname(CONFIG['LOG_FILE'])
    if not os.path.exists(log_dir):
        os.makedirs(log_dir, exist_ok=True)
    
    logging.basicConfig(
        level=getattr(logging, CONFIG['LOG_LEVEL']),
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(CONFIG['LOG_FILE']),
            logging.StreamHandler(sys.stdout)
        ]
    )
    return logging.getLogger(__name__)

logger = setup_logging()

# ============================================================
# HELPER FUNCTIONS
# ============================================================

def compress_image(frame, quality, max_size):
    """Compress image to save bandwidth"""
    # Encode to JPEG with quality setting
    _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    
    # If still too large, reduce quality
    while len(buffer) > max_size and quality > 20:
        quality -= 5
        _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    
    return buffer, quality

def detect_motion(current_frame, previous_frame, threshold):
    """Detect motion between two frames"""
    if previous_frame is None:
        return True  # First frame, always capture
    
    # Convert to grayscale for comparison
    gray1 = cv2.cvtColor(previous_frame, cv2.COLOR_BGR2GRAY)
    gray2 = cv2.cvtColor(current_frame, cv2.COLOR_BGR2GRAY)
    
    # Compute difference
    diff = cv2.absdiff(gray1, gray2)
    
    # Apply threshold
    _, thresh = cv2.threshold(diff, 30, 255, cv2.THRESH_BINARY)
    
    # Count white pixels (changes)
    motion_pixels = cv2.countNonZero(thresh)
    
    return motion_pixels > threshold

def capture_frame(cap):
    """Capture frame from camera"""
    ret, frame = cap.read()
    if not ret:
        logger.error("Failed to capture frame from camera")
        return None
    return frame

def upload_frame(frame, device_id, token, server_url, metadata=None):
    """Upload frame to server"""
    try:
        # Compress image
        image_buffer, final_quality = compress_image(
            frame, 
            CONFIG['QUALITY'],
            CONFIG['MAX_IMAGE_SIZE']
        )
        
        # Convert to base64
        image_base64 = base64.b64encode(image_buffer).decode('utf-8')
        
        # Prepare payload
        payload = {
            'device_id': device_id,
            'image_data': image_base64,
            'metadata': {
                'timestamp': datetime.now().isoformat(),
                'sensor_type': 'camera_pi',
                'resolution': f"{frame.shape[1]}x{frame.shape[0]}",
                'quality': final_quality,
                'image_size': len(image_buffer),
                **(metadata or {})
            }
        }
        
        # Send request
        headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }
        
        url = f"{server_url}/api/sensor-data/submit"
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        
        if response.status_code == 200:
            result = response.json()
            logger.info(f"Frame uploaded successfully (ID: {result.get('data_id')}, size: {len(image_buffer)} bytes)")
            return True
        else:
            logger.error(f"Upload failed: HTTP {response.status_code} - {response.text}")
            return False
            
    except requests.exceptions.Timeout:
        logger.error("Upload timeout")
        return False
    except requests.exceptions.ConnectionError:
        logger.error("Connection error - server may be unreachable")
        return False
    except Exception as e:
        logger.error(f"Upload error: {str(e)}")
        return False

def retry_upload(frame, device_id, token, server_url, metadata=None, max_retries=3):
    """Automatically retry upload if it fails"""
    for attempt in range(max_retries):
        logger.info(f"Upload attempt {attempt + 1}/{max_retries}")
        if upload_frame(frame, device_id, token, server_url, metadata):
            return True
        if attempt < max_retries - 1:
            logger.info(f"Retrying in {CONFIG['RETRY_DELAY']} seconds...")
            time.sleep(CONFIG['RETRY_DELAY'])
    return False

# ============================================================
# MAIN CAPTURE LOOP
# ============================================================

class CameraCaptureService:
    def __init__(self, config):
        self.config = config
        self.running = False
        self.camera = None
        self.previous_frame = None
        self.frames_captured = 0
        self.frames_uploaded = 0
    
    def start(self):
        """Start camera capture service"""
        logger.info("Starting camera capture service...")
        
        # Validate configuration
        if not self.config['JWT_TOKEN'] or self.config['JWT_TOKEN'] == 'YOUR_JWT_TOKEN_HERE':
            logger.error("ERROR: JWT_TOKEN not configured. Please set your token in CONFIG.")
            return False
        
        # Initialize camera
        self.camera = cv2.VideoCapture(self.config['CAMERA_INDEX'])
        if not self.camera.isOpened():
            logger.error(f"Failed to open camera at index {self.config['CAMERA_INDEX']}")
            return False
        
        # Set camera properties
        self.camera.set(cv2.CAP_PROP_FRAME_WIDTH, self.config['FRAME_WIDTH'])
        self.camera.set(cv2.CAP_PROP_FRAME_HEIGHT, self.config['FRAME_HEIGHT'])
        self.camera.set(cv2.CAP_PROP_FPS, self.config['FPS'])
        
        logger.info("Camera initialized successfully")
        logger.info(f"Resolution: {int(self.camera.get(cv2.CAP_PROP_FRAME_WIDTH))}x{int(self.camera.get(cv2.CAP_PROP_FRAME_HEIGHT))}")
        logger.info(f"FPS: {int(self.camera.get(cv2.CAP_PROP_FPS))}")
        
        self.running = True
        return True
    
    def stop(self):
        """Stop camera capture service"""
        logger.info("Stopping camera capture service...")
        self.running = False
        if self.camera:
            self.camera.release()
        logger.info(f"Service stopped. Captured: {self.frames_captured}, Uploaded: {self.frames_uploaded}")
    
    def run_capture_loop(self):
        """Main capture loop"""
        last_capture_time = time.time()
        
        while self.running:
            try:
                # Capture frame
                frame = capture_frame(self.camera)
                if frame is None:
                    time.sleep(1)
                    continue
                
                # Check if it's time to upload
                current_time = time.time()
                should_upload = (current_time - last_capture_time) >= self.config['CAPTURE_INTERVAL']
                
                # Motion detection
                has_motion = True
                if self.config['MOTION_DETECTION']:
                    has_motion = detect_motion(frame, self.previous_frame, self.config['MOTION_THRESHOLD'])
                    if has_motion:
                        logger.debug("Motion detected")
                    self.previous_frame = frame.copy()
                
                # Upload if criteria met
                if should_upload and has_motion:
                    self.frames_captured += 1
                    
                    # Prepare metadata
                    metadata = {
                        'motion_detected': has_motion,
                        'capture_number': self.frames_captured
                    }
                    
                    # Try to upload with retry logic
                    if retry_upload(
                        frame,
                        self.config['DEVICE_ID'],
                        self.config['JWT_TOKEN'],
                        self.config['SERVER_URL'],
                        metadata,
                        self.config['MAX_RETRIES']
                    ):
                        self.frames_uploaded += 1
                    
                    last_capture_time = current_time
                
                # Small sleep to reduce CPU usage
                time.sleep(0.1)
                
            except Exception as e:
                logger.error(f"Error in capture loop: {str(e)}")
                time.sleep(1)
    
    def run(self):
        """Start the service and run capture loop"""
        if self.start():
            try:
                self.run_capture_loop()
            except KeyboardInterrupt:
                print("\n")
                self.stop()
            except Exception as e:
                logger.error(f"Fatal error: {str(e)}")
                self.stop()

# ============================================================
# ENTRYPOINT
# ============================================================

if __name__ == '__main__':
    # Handle graceful shutdown
    def signal_handler(sig, frame):
        logger.info("Received shutdown signal")
        service.stop()
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Start service
    service = CameraCaptureService(CONFIG)
    service.run()

import os
import sys
from PIL import Image, ImageGrab

output_path = sys.argv[1] if len(sys.argv) > 1 else r"E:\repos\acp-desktop\.tmp\qapert_screenshot.png"

# Capture the entire primary screen
screenshot = ImageGrab.grab()
screenshot.save(output_path)
print(f"Screenshot saved to {output_path}")
print(f"Size: {screenshot.size}")

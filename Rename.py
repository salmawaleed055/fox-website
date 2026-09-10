import os
import re

# Folder path
folder_path = r"D:/Fox-website/github/fox-website/anim/gallery"

# Helper function to extract numbers from filenames for sorting
def extract_number(filename):
    numbers = re.findall(r'\d+', filename)
    return int(numbers[0]) if numbers else -1

# Get all files and sort them numerically based on existing numbers
files = [f for f in os.listdir(folder_path) if os.path.isfile(os.path.join(folder_path, f))]
files.sort(key=extract_number)

# Step 1: Rename files to a temporary name to avoid filename collisions
temp_files = []
for index, file_name in enumerate(files):
    ext = os.path.splitext(file_name)[1]
    old_path = os.path.join(folder_path, file_name)
    temp_name = f"__temp_{index}__{ext}"
    temp_path = os.path.join(folder_path, temp_name)
    
    os.rename(old_path, temp_path)
    temp_files.append((temp_path, ext))

# Step 2: Rename temporary files to 4-digit format (0000, 0001, ..., 0080)
for index, (temp_path, ext) in enumerate(temp_files):
    new_name = f"{index:04d}{ext}"
    new_path = os.path.join(folder_path, new_name)
    os.rename(temp_path, new_path)

print(f"Successfully renamed {len(files)} files (from {0:04d} to {len(files)-1:04d})!")
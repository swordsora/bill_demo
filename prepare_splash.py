from pathlib import Path
from PIL import Image

source = Path('/home/ubuntu/upload/FB_IMG_1787684103013.jpg')
target = Path('/home/ubuntu/Invoice Program-pwa/splash-icon.png')
image = Image.open(source).convert('RGB')
image = image.resize((2048, 2048), Image.Resampling.LANCZOS)
image.save(target, format='PNG', optimize=True)
Path('/home/ubuntu/Invoice Program-pwa/splash.png').write_bytes(target.read_bytes())
print(target)

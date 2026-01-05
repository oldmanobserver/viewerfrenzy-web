Vehicle thumbnails / preview images (optional)

The web Garage will try to load images from:

  /assets/vehicles/<type>/<id>.webp
  /assets/vehicles/<type>/<id>.png
  /assets/vehicles/<type>/<id>.jpg
  /assets/vehicles/<type>/<id>.jpeg

Where:
  <type> is one of: ground, resort, space (and any other types you add)
  <id> is the exact vehicle id from /public/data/vehicleCatalog.json

Examples:
  /assets/vehicles/ground/BlueCar.png
  /assets/vehicles/space/VF_Ship_StarSparrow_01.webp
  /assets/vehicles/resort/tube_blue.png

If an image is missing, the site falls back to a generated placeholder graphic.

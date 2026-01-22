Track Component thumbnails / preview images (optional)

The ViewerFrenzy Admin site (manage.<domain>) and any other tools can load
optional track component images from:

  /assets/track-components/<relative>.webp
  /assets/track-components/<relative>.png
  /assets/track-components/<relative>.jpg
  /assets/track-components/<relative>.jpeg

Where:
  <relative> is derived from the component's Resources.Load path.

Example component.resourcesPath:
  TrackComponents/SpaceStationsCreator/Examples/Alien/AlienSpaceStation1

Becomes:
  /assets/track-components/SpaceStationsCreator/Examples/Alien/AlienSpaceStation1.png

Recommended generation workflow:
  1) In Unity: Tools -> ViewerFrenzy -> Web -> Export Track Component PNGs (512) - 3/4
  2) Select this folder:
       viewerfrenzy-web/public/assets/track-components
  3) Commit + redeploy viewerfrenzy.com

If an image is missing, the UI will fall back to a generated placeholder.

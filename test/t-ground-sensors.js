/* Ground sensor overlays stay hidden in both the arena and title demo.
 * Sensor detection is exercised separately by t-stealth.js. */
const fs = require('fs');
const path = require('path');
const { ROOT, check, assert } = require('./helpers');

const main = fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8');

check('the scene does not allocate or draw vision-cone meshes', () => {
  assert(!/Geometry\.gaze(?:Cone|Edge|Curtain)\s*\(/.test(main),
    'ground sensor meshes are still allocated');
  assert(!/M\.gaze(?:Edge|Curtain)?\b/.test(main),
    'a title or gameplay vision overlay is still referenced');
});

check('the scene does not draw sight or hearing range boundaries', () => {
  assert(!/\bsense(?:Range|Near)\s*\(/.test(main),
    'sensor reach is being used by the ground renderer');
});

check('the manual no longer tells players to follow ground sensor ranges', () => {
  for (const file of ['README.md', 'index.html']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert(!/both drawn on\s+the ground|cones\s+on the ground/i.test(text),
      file + ' still describes removed sensor overlays');
  }
});

/* Built-in examples, in the same spec format Claude writes. Millimetres; x left to right, y back to front, z up, every part where it sits assembled. */
const PRESETS = [
  {
    object: "iPhone (2007)",
    parts: [
      { name: "Display Assembly", kind: "box", at: [1, 1, 9.6], size: [113, 59, 2], r: 9, features: [
        { t: "inset", by: 1 }, { t: "slot", at: [54, 29.5], size: [74, 50], r: 0.8 }, { t: "hole", at: [103, 29.5], d: 11 },
        { t: "slot", at: [9, 29.5], size: [2.2, 11], r: 1.1 }, { t: "hole", at: [9, 21.5], d: 1.6 } ] },
      { name: "Chassis", kind: "tray", at: [0, 0, 6.8], size: [115, 61, 4.8], r: 10, wall: 1.6, floor: false, features: [
        { t: "slot", face: "front", at: [22, 2.4], size: [8, 1.8], r: 0.9 }, { t: "slot", face: "front", at: [33, 2.4], size: [8, 1.8], r: 0.9 },
        { t: "slot", face: "side", at: [30.5, 2.4], size: [13, 1.6], r: 0.8 }, { t: "hole", face: "side", at: [12, 2.4], d: 1.6 } ] },
      { name: "Sleep and Wake", kind: "box", at: [1.8, 40, 7], size: [2.4, 12, 2.6], r: 1.1, features: [
        { t: "boss", at: [1.2, 6], size: [1.4, 8, 0.5], r: 0.6 } ] },
      { name: "SIM Tray", kind: "box", at: [3, 8, 8.4], size: [22, 15, 1.1], r: 1.4, features: [
        { t: "slot", at: [12, 7.5], size: [14, 11], r: 1.2 }, { t: "hole", at: [2.6, 7.5], d: 1.4 }, { t: "line", at: [20.4, 2], to: [20.4, 13] } ] },
      { name: "Earpiece Speaker", kind: "box", at: [3, 24, 8.6], size: [5.5, 13, 1], r: 1.4, features: [
        { t: "grille", at: [2.75, 6.5], size: [3, 10], pitch: 1.1 } ] },
      { name: "Camera Module", kind: "box", qty: 2, at: [5, 46, 6.8], size: [9, 9, 2.8], r: 2, features: [
        { t: "pin", at: [4.5, 4.5], d: 6.2, h: 0.5 }, { t: "pin", at: [4.5, 4.5], d: 3.2, h: 0.3, z: 0.5 },
        { t: "boss", face: "front", at: [4.5, 1.4], size: [5, 1.2, 0.8], r: 0.4 } ] },
      { name: "Antenna Flex", kind: "flex", at: [58, 2.5, 9.2], size: [0, 0, 0.3], width: 3.2, path: [[0, 0], [26, 0], [26, 5], [40, 5]], features: [
        { t: "boss", at: [40, 5], size: [5, 4, 0.3], r: 0.5 }, { t: "boss", at: [0, 0], size: [4, 4, 0.3], r: 0.5 } ] },
      { name: "Dock Ribbon Cable", kind: "flex", at: [52, 32, 9], size: [0, 0, 0.3], width: 6, path: [[0, 0], [18, 0], [18, 9], [50, 9]], features: [
        { t: "boss", at: [0, 0], size: [5, 8, 0.3], r: 0.5 }, { t: "boss", at: [50, 9], size: [5, 8, 0.3], r: 0.5 } ] },
      { name: "Shield Plate", kind: "box", at: [6, 5, 6.2], size: [46, 51, 0.5], r: 2.2, screws: 4, features: [
        { t: "inset", by: 1.2 }, { t: "slot", at: [23, 25.5], size: [30, 32], r: 2 },
        { t: "hole", at: [3.2, 3.2], d: 1.8 }, { t: "hole", at: [42.8, 3.2], d: 1.8 }, { t: "hole", at: [3.2, 47.8], d: 1.8 }, { t: "hole", at: [42.8, 47.8], d: 1.8 } ] },
      { name: "Grounding Flex", kind: "flex", at: [18, 57, 5.8], size: [0, 0, 0.3], width: 2.8, path: [[0, 0], [0, -7], [16, -7], [16, -13]], features: [
        { t: "boss", at: [0, 0], size: [3.4, 3.4, 0.2], r: 0.4 }, { t: "boss", at: [16, -13], size: [4, 3.6, 0.2], r: 0.4 } ] },
      { name: "Logic Board", kind: "box", at: [6, 5, 4.4], size: [46, 51, 1], r: 1.6, screws: 2, features: [
        { t: "hole", at: [2.5, 2.5], d: 1.6 }, { t: "hole", at: [43.5, 48.5], d: 1.6 }, { t: "grille", at: [38, 45], size: [8, 4], pitch: 1.2 },
        { t: "boss", at: [13, 14], size: [12, 12, 0.6], r: 0.6 }, { t: "boss", at: [31, 12], size: [10, 8, 0.5], r: 0.5 },
        { t: "boss", at: [32, 31], size: [12, 14, 0.6], r: 0.5 }, { t: "boss", at: [13, 36], size: [9, 9, 0.4], r: 0.5 },
        { t: "boss", at: [21, 47], size: [16, 3.4, 0.6], r: 0.4 } ] },
      { name: "Battery", kind: "box", at: [54, 6, 4.4], size: [42, 45, 4.2], r: 3.5, features: [
        { t: "inset", by: 2.5 }, { t: "line", at: [7, 22.5], to: [36, 22.5] }, { t: "boss", at: [4, 10], size: [5, 8, 0.4], r: 0.5 } ] },
      { name: "Vibration Motor", kind: "cyl", axis: "x", at: [60, 53, 4.6], size: [13, 5, 5], features: [
        { t: "pin", face: "side", at: [2.5, 2.5], d: 2.4, h: 2 } ] },
      { name: "Loudspeaker Assembly", kind: "box", at: [100, 4, 4.6], size: [11, 21, 4], r: 2, screws: 2, features: [
        { t: "grille", at: [5.5, 10.5], size: [6, 16], pitch: 1.3 }, { t: "hole", at: [5.5, 1.6], d: 1.4 }, { t: "hole", at: [5.5, 19.4], d: 1.4 },
        { t: "boss", face: "side", at: [10.5, 2], size: [14, 1.6, 0.8], r: 0.6 } ] },
      { name: "Dock Connector", kind: "box", at: [103, 26, 4.8], size: [8, 15, 3.4], r: 1.2, screws: 2, features: [
        { t: "slot", face: "side", at: [7.5, 1.7], size: [12, 1.5], r: 0.7 }, { t: "boss", at: [3.5, 7.5], size: [4, 10, 0.5], r: 0.5 } ] },
      { name: "Antenna Cover", kind: "tray", at: [97.5, 1.2, 1.1], size: [16.3, 58.6, 3.3], r: 8, wall: 1.1, features: [
        { t: "slot", at: [8.2, 29.3], size: [3, 24], r: 1.5 }, { t: "hole", at: [8.2, 7], d: 3.2 } ] },
      { name: "Rear Case", kind: "tray", at: [0, 0, 0], size: [115, 61, 6.8], r: 10, wall: 1.1, features: [
        { t: "hole", at: [9.5, 50.5], d: 6.5 }, { t: "pin", at: [20, 6], d: 2.4, h: 1.6 }, { t: "pin", at: [20, 55], d: 2.4, h: 1.6 },
        { t: "pin", at: [60, 6], d: 2.4, h: 1.6 }, { t: "pin", at: [60, 55], d: 2.4, h: 1.6 } ] },
    ],
  },
  {
    object: "Game Boy (1989)",
    parts: [
      { name: "Screen Lens", kind: "box", at: [10, 8, 33], size: [62, 74, 1.2], r: 3, features: [
        { t: "inset", by: 5 }, { t: "slot", at: [31, 37], size: [42, 46], r: 0.6 }, { t: "hole", at: [21, 4.2], d: 2 } ] },
      { name: "D-Pad", kind: "box", shape: "plus", at: [83, 9, 33], size: [26, 26, 2.6], r: 1, features: [{ t: "hole", at: [13, 13], d: 3 }] },
      { name: "A and B Buttons", kind: "cyl", qty: 2, at: [89, 57, 33], size: [10, 10, 2.4], features: [{ t: "pin", at: [5, 5], d: 7, h: 0.4 }] },
      { name: "Start and Select", kind: "box", qty: 2, at: [117, 30, 33], size: [10, 4, 1.4], r: 2 },
      { name: "Front Housing", kind: "box", at: [0, 0, 19.4], size: [148, 90, 13.6], r: 6, features: [
        { t: "slot", at: [41, 45], size: [64, 78], r: 3 }, { t: "cross", at: [96, 22], size: [27, 9.5] },
        { t: "hole", at: [94, 62], d: 11 }, { t: "hole", at: [104, 76], d: 11 },
        { t: "slot", at: [122, 32], size: [4, 11], r: 2 }, { t: "slot", at: [122, 44], size: [4, 11], r: 2 },
        { t: "line", at: [122, 62], to: [130, 76] }, { t: "line", at: [125.4, 62], to: [133.4, 76] }, { t: "line", at: [128.8, 62], to: [136.8, 76] },
        { t: "line", at: [132.2, 62], to: [140.2, 76] }, { t: "line", at: [135.6, 62], to: [143.6, 76] },
        { t: "hole", face: "side", at: [16, 7], d: 4 }, { t: "line", face: "front", at: [8, 1.5], to: [140, 1.5] } ] },
      { name: "Contact Pads", kind: "box", at: [80, 6, 18], size: [50, 80, 1.4], r: 3, features: [
        { t: "pin", at: [16, 16], d: 7, h: 0.8 }, { t: "pin", at: [24, 56], d: 8, h: 0.8 }, { t: "pin", at: [14, 70], d: 8, h: 0.8 },
        { t: "pin", at: [42, 26], d: 4, h: 0.6 }, { t: "pin", at: [42, 38], d: 4, h: 0.6 } ] },
      { name: "Front Board", kind: "box", at: [4, 4, 16.4], size: [140, 82, 1.6], r: 2, screws: 2, features: [
        { t: "hole", at: [3.5, 3.5], d: 2.4 }, { t: "hole", at: [136.5, 78.5], d: 2.4 },
        { t: "hole", at: [92, 18], d: 12 }, { t: "hole", at: [90, 58], d: 9 }, { t: "hole", at: [100, 72], d: 9 },
        { t: "slot", at: [118, 28], size: [3, 9], r: 1.5 }, { t: "slot", at: [118, 40], size: [3, 9], r: 1.5 },
        { t: "boss", at: [40, 41], size: [50, 58, 1.4], r: 1 } ] },
      { name: "Ribbon Cable", kind: "flex", at: [8, 45, 15.4], size: [0, 0, 0.4], width: 20, path: [[0, 0], [26, 0]], features: [
        { t: "boss", at: [0, 0], size: [4, 20, 0.6], r: 0.4 }, { t: "boss", at: [26, 0], size: [4, 20, 0.6], r: 0.4 } ] },
      { name: "CPU Board", kind: "box", at: [4, 4, 4], size: [80, 82, 1.6], r: 2, screws: 2, features: [
        { t: "hole", at: [3.5, 3.5], d: 2.4 }, { t: "hole", at: [76.5, 78.5], d: 2.4 },
        { t: "grille", at: [62, 64], size: [14, 10], pitch: 2 }, { t: "boss", at: [6, 45], size: [7, 60, 7], r: 0.6 },
        { t: "boss", at: [32, 30], size: [17, 17, 1.6], r: 0.5 }, { t: "boss", at: [32, 56], size: [13, 8, 1.4], r: 0.4 },
        { t: "boss", at: [56, 30], size: [13, 8, 1.4], r: 0.4 }, { t: "pin", at: [66, 14], d: 6, h: 6 }, { t: "pin", at: [74, 14], d: 4.5, h: 4.5 },
        { t: "boss", at: [24, 74], size: [8, 6, 3], r: 0.6 } ] },
      { name: "AA Batteries", kind: "cyl", axis: "x", qty: 4, at: [88, 12, 1.2], size: [50.5, 14.5, 14.5], features: [
        { t: "pin", face: "side", at: [7.25, 7.25], d: 5.5, h: 1.2 } ] },
      { name: "Speaker", kind: "cyl", at: [112, 58, 4], size: [26, 26, 5], features: [
        { t: "hole", at: [13, 13], d: 20 }, { t: "pin", at: [13, 13], d: 11, h: 1.4 } ] },
      { name: "Volume Wheel", kind: "cyl", axis: "y", at: [30, 86, 6], size: [14, 3, 14], features: [{ t: "hole", face: "front", at: [7, 7], d: 3 }] },
      { name: "Power Switch", kind: "box", at: [2.4, 62, 9], size: [7, 14, 5], r: 1.5, features: [{ t: "boss", at: [3.5, 4.5], size: [3.4, 5, 2.2], r: 0.9 }] },
      { name: "Back Housing", kind: "tray", at: [0, 0, 0], size: [148, 90, 16], r: 6, wall: 2.2, screws: 4, features: [
        { t: "slot", at: [114, 45], size: [58, 74], r: 4 },
        { t: "hole", at: [10, 10], d: 2.6 }, { t: "hole", at: [138, 80], d: 2.6 }, { t: "hole", at: [138, 10], d: 2.6 }, { t: "hole", at: [10, 80], d: 2.6 },
        { t: "slot", face: "front", at: [40, 8], size: [16, 4.5], r: 1.5 }, { t: "hole", face: "side", at: [16, 8], d: 4 } ] },
      { name: "Battery Cover", kind: "box", at: [86, 8, -2.2], size: [56, 74, 2.2], r: 4, features: [
        { t: "inset", by: 2 }, { t: "line", at: [8, 24], to: [8, 50] }, { t: "line", at: [11.5, 24], to: [11.5, 50] }, { t: "line", at: [15, 24], to: [15, 50] },
        { t: "boss", at: [51, 37], size: [3, 20, 1], r: 1 } ] },
    ],
  },
];

// Pixel sprites: character maps + palette ('.' = transparent). Drawn 1:1 on the low-res canvas, scaled up nearest-neighbour.
window.NES = {
  G: "#80d010",
  S: "#fc9838",
  B: "#c84c0c",
  W: "#fcfcfc",
  R: "#d82800",
  D: "#881400",
  K: "#000000",
  U: "#2038ec",
  O: "#e45c10",
  Y: "#fcbc3c",
  g: "#bcbcbc",
  L: "#a4e4fc",
  N: "#ac7c00",
  A: "#7c7c7c",
};

window.SPR = {
  // An original silent hero (spiky hair, red scarf). Restyle per world; never copy a game's character.
  kid: [
    [
      "...D.D..D.D.....",
      "..DDDDDDDDDD....",
      ".DDDDDDDDDDDD...",
      ".DDSSSSSSSSDD...",
      "..DSDSSSSDSSD...",
      "..DSSSSSSSSSD...",
      "...SSSSSSSSS....",
      "..RRRRRRRRRRR...",
      ".RRUUUUUUUURRR..",
      ".SUUUUUUUUUURRR.",
      ".SUUUDDDDUUUS.R.",
      "..UUUUUUUUUU....",
      "..UUUUUUUUUU....",
      "...UUU..UUU.....",
      "...DDD..DDD.....",
      "..DDDD..DDDD....",
    ],
    [
      "...D.D..D.D.....",
      "..DDDDDDDDDD....",
      ".DDDDDDDDDDDD...",
      ".DDSSSSSSSSDD...",
      "..DSDSSSSDSSD...",
      "..DSSSSSSSSSD...",
      "...SSSSSSSSS....",
      "..RRRRRRRRRRR...",
      ".RRUUUUUUUURRRR.",
      ".SUUUUUUUUUU.RR.",
      ".SUUUDDDDUUUS...",
      "..UUUUUUUUUU....",
      "..UUUUUUUUUU....",
      "....UUU.UUU.....",
      "....DDD.DDD.....",
      "...DDDD.DDDD....",
    ],
  ],
  oldman: [
    [
      ".....RRRRRR.....",
      "....RRRRRRRR....",
      "...RRSSSSSSRR...",
      "...RSDSSSSDSR...",
      "...RSWWWWWWSR...",
      "...RWWWWWWWWR...",
      "..RRWWWWWWWWRR..",
      "..RRRWWWWWWRRR..",
      ".RRRRRWWWWRRRRR.",
      ".RRSRRRWWRRRSRR.",
      ".RRSRRRRRRRRSRR.",
      "..RRRRRRRRRRRR..",
      "..RRRRRRRRRRRR..",
      "..RRRRRRRRRRRR..",
      ".RRRRRRRRRRRRRR.",
      ".RRRRRRRRRRRRRR.",
    ],
  ],
  fire: [
    [
      ".......R........",
      "......RR....R...",
      "..R...RRR..RR...",
      "..RR.RRSRR.RR...",
      "..RRRRRSSRRRR...",
      ".RRRRSSSSRRRRR..",
      ".RRRSSWWSSSRRR..",
      ".RRSSWWWWSSRRR..",
      "RRRSSWWWWWSSRRR.",
      "RRSSWWWWWWWSSRR.",
      "RRSSWWWWWWWSSRR.",
      ".RRSSWWWWWSSRR..",
      ".RRRSSSSSSSRRR..",
      "..RRRRRRRRRRR...",
      "...RRRRRRRRR....",
      "....RRRRRRR.....",
    ],
  ],
  sword: [
    [
      "...W....",
      "..WWW...",
      "..WWW...",
      "..WgW...",
      "..WgW...",
      "..WgW...",
      "..WgW...",
      "..WgW...",
      "..WWW...",
      "BBBBBBB.",
      "...B....",
      "...B....",
      "..BBB...",
    ],
  ],
  dots: [
    [
      // 「……」气泡
      "WWWWWWWWWWWWWWWW",
      "WKKKKKKKKKKKKKKW",
      "WKKKKKKKKKKKKKKW",
      "WKKWKKKKWKKKKWKW",
      "WKKKKKKKKKKKKKKW",
      "WWWWWWWWWWWWWWWW",
      "......WW........",
      "......W.........",
    ],
  ],
};
// fire frame 2 = mirror of frame 1
SPR.fire.push(SPR.fire[0].map((r) => r.split("").reverse().join("")));

// pal: optional colour overrides { char: colour } to recolour one map
window.drawSpr = (g, frames, i, x, y, flip = false, pal) => {
  const f = frames[((i % frames.length) + frames.length) % frames.length];
  for (let r = 0; r < f.length; r++)
    for (let q = 0; q < f[r].length; q++) {
      const ch = f[r][flip ? f[r].length - 1 - q : q];
      if (ch === ".") continue;
      g.fillStyle = (pal && pal[ch]) || NES[ch];
      g.fillRect(x + q, y + r, 1, 1);
    }
};
window.sprW = (frames) => frames[0][0].length;
window.sprH = (frames) => frames[0].length;

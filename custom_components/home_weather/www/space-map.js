/**
 * Space Map — "Celestial Atlas"
 * A 2D astronomy tracker for the Home Weather panel, rendered as a refined
 * star-chart: Solar System mode (heliocentric, zodiac band, J2000 Keplerian
 * planet positions, NEOs from JPL via the backend) and Earth mode (geocentric,
 * true Moon longitude + phase, satellite passes, deep-space probes).
 *
 * Plain canvas + DOM. No frameworks, no build step, no three.js.
 * Positions: NASA SSD approximate J2000 elements (planets) and a
 * low-precision lunar theory (Moon). Backend data is never faked — when a
 * feed is empty we show a designed empty state instead.
 */
(function (global) {
  "use strict";

  /* ========================= Constants & ephemeris ========================= */

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const TWO_PI = Math.PI * 2;
  const AU_KM = 149597870.7;
  const LD_KM = 384400;
  const TS = "\uFE0E"; // variation selector: force text-style glyphs, not emoji

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const ZODIAC = [
    { name: "Aries", glyph: "\u2648", element: "Fire", quality: "Cardinal" },
    { name: "Taurus", glyph: "\u2649", element: "Earth", quality: "Fixed" },
    { name: "Gemini", glyph: "\u264A", element: "Air", quality: "Mutable" },
    { name: "Cancer", glyph: "\u264B", element: "Water", quality: "Cardinal" },
    { name: "Leo", glyph: "\u264C", element: "Fire", quality: "Fixed" },
    { name: "Virgo", glyph: "\u264D", element: "Earth", quality: "Mutable" },
    { name: "Libra", glyph: "\u264E", element: "Air", quality: "Cardinal" },
    { name: "Scorpio", glyph: "\u264F", element: "Water", quality: "Fixed" },
    { name: "Sagittarius", glyph: "\u2650", element: "Fire", quality: "Mutable" },
    { name: "Capricorn", glyph: "\u2651", element: "Earth", quality: "Cardinal" },
    { name: "Aquarius", glyph: "\u2652", element: "Air", quality: "Fixed" },
    { name: "Pisces", glyph: "\u2653", element: "Water", quality: "Mutable" },
  ];

  // Chinese Zodiac: 12 animals in traditional order starting from Rat
  // Each animal corresponds to a 2-hour period (shichen) and maps to 30° sectors
  // Aligned so Rat starts at the same position as Aries (0°) for visual symmetry
  const CHINESE_ZODIAC = [
    { name: "Rat", hanzi: "鼠", pinyin: "Shǔ", element: "Water", yin: true },
    { name: "Ox", hanzi: "牛", pinyin: "Niú", element: "Earth", yin: false },
    { name: "Tiger", hanzi: "虎", pinyin: "Hǔ", element: "Wood", yin: true },
    { name: "Rabbit", hanzi: "兔", pinyin: "Tù", element: "Wood", yin: false },
    { name: "Dragon", hanzi: "龍", pinyin: "Lóng", element: "Earth", yin: true },
    { name: "Snake", hanzi: "蛇", pinyin: "Shé", element: "Fire", yin: false },
    { name: "Horse", hanzi: "馬", pinyin: "Mǎ", element: "Fire", yin: true },
    { name: "Goat", hanzi: "羊", pinyin: "Yáng", element: "Earth", yin: false },
    { name: "Monkey", hanzi: "猴", pinyin: "Hóu", element: "Metal", yin: true },
    { name: "Rooster", hanzi: "雞", pinyin: "Jī", element: "Metal", yin: false },
    { name: "Dog", hanzi: "狗", pinyin: "Gǒu", element: "Earth", yin: true },
    { name: "Pig", hanzi: "豬", pinyin: "Zhū", element: "Water", yin: false },
  ];

  const PLANET_GLYPHS = {
    Mercury: "\u263F", Venus: "\u2640", Earth: "\u2295", Mars: "\u2642",
    Jupiter: "\u2643", Saturn: "\u2644", Uranus: "\u2645", Neptune: "\u2646",
    Pluto: "\u2647", Sun: "\u2609", Moon: "\u263D",
  };

  /** J2000 Keplerian elements + century rates (NASA SSD approx_pos). */
  const PLANET_ELEMENTS = {
    Mercury: {
      a: [0.38709927, 0.00000037], e: [0.20563593, 0.00001906],
      I: [7.00497902, -0.00594749], L: [252.25032350, 149472.67411175],
      w: [77.45779628, 0.16047689], O: [48.33076593, -0.12534081],
      period: 87.969, color: "#b8bec8", lightColor: "#6b7280", size: 3.4,
    },
    Venus: {
      a: [0.72333566, 0.00000390], e: [0.00677672, -0.00004107],
      I: [3.39467605, -0.00078890], L: [181.97909950, 58517.81538729],
      w: [131.60246718, 0.00268329], O: [76.67984255, -0.27769418],
      period: 224.701, color: "#eed9a8", lightColor: "#a8842e", size: 5,
    },
    Earth: {
      a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392],
      I: [-0.00001531, -0.01294668], L: [100.46457166, 35999.37244981],
      w: [102.93768193, 0.32327364], O: [0.0, 0.0],
      period: 365.256, color: "#6aa5f0", lightColor: "#2d5fa8", size: 5.2,
    },
    Mars: {
      a: [1.52371034, 0.00001847], e: [0.09339410, 0.00007882],
      I: [1.84969142, -0.00813131], L: [-4.55343205, 19140.30268499],
      w: [-23.94362959, 0.44441088], O: [49.55953891, -0.29257343],
      period: 686.98, color: "#d96b4f", lightColor: "#a83c22", size: 4.2,
    },
    Jupiter: {
      a: [5.20288700, -0.00011607], e: [0.04838624, -0.00013253],
      I: [1.30439695, -0.00183714], L: [34.39644051, 3034.74612775],
      w: [14.72847983, 0.21252668], O: [100.47390909, 0.20469106],
      period: 4332.59, color: "#e0b184", lightColor: "#96602a", size: 9,
    },
    Saturn: {
      a: [9.53667594, -0.00125060], e: [0.05386179, -0.00050991],
      I: [2.48599187, 0.00193609], L: [49.95424423, 1222.49362201],
      w: [92.59887831, -0.41897216], O: [113.66242448, -0.28867794],
      period: 10759.22, color: "#ecd9a8", lightColor: "#8f7a35", size: 7.6,
    },
    Uranus: {
      a: [19.18916464, -0.00196176], e: [0.04725744, -0.00004397],
      I: [0.77263783, -0.00242939], L: [313.23810451, 428.48202785],
      w: [170.95427630, 0.40805281], O: [74.01692503, 0.04240589],
      period: 30688.5, color: "#9fdbee", lightColor: "#2e7f99", size: 6.4,
    },
    Neptune: {
      a: [30.06992276, 0.00026291], e: [0.00859048, 0.00005105],
      I: [1.77004347, 0.00035372], L: [-55.12002969, 218.45945325],
      w: [44.96476227, -0.32284022], O: [131.78422574, -0.00508664],
      period: 60182, color: "#8390e8", lightColor: "#3a48a8", size: 6.2,
    },
    Pluto: {
      a: [39.48211675, -0.00031596], e: [0.24882730, 0.00005170],
      I: [17.14001206, 0.00004818], L: [238.92903833, 145.20780515],
      w: [224.06891629, -0.04062942], O: [110.30393684, -0.01183482],
      period: 90560, color: "#c4ab9d", lightColor: "#7a6455", size: 3.2, dwarf: true,
    },
  };

  const PLANET_ORDER = Object.keys(PLANET_ELEMENTS);

  /** Real reference facts for major moons (info cards + schematic diagram). */
  const MOON_FACTS = {
    Earth: [{ name: "Moon", periodD: 27.322, distKm: 384400 }],
    Mars: [
      { name: "Phobos", periodD: 0.319, distKm: 9376 },
      { name: "Deimos", periodD: 1.263, distKm: 23463 },
    ],
    Jupiter: [
      { name: "Io", periodD: 1.769, distKm: 421800 },
      { name: "Europa", periodD: 3.551, distKm: 671100 },
      { name: "Ganymede", periodD: 7.155, distKm: 1070400 },
      { name: "Callisto", periodD: 16.689, distKm: 1882700 },
    ],
    Saturn: [
      { name: "Enceladus", periodD: 1.370, distKm: 238020 },
      { name: "Rhea", periodD: 4.518, distKm: 527108 },
      { name: "Titan", periodD: 15.945, distKm: 1221870 },
      { name: "Iapetus", periodD: 79.32, distKm: 3560820 },
    ],
    Uranus: [
      { name: "Titania", periodD: 8.706, distKm: 435910 },
      { name: "Oberon", periodD: 13.463, distKm: 583520 },
    ],
    Neptune: [{ name: "Triton", periodD: 5.877, distKm: 354759 }],
    Pluto: [{ name: "Charon", periodD: 6.387, distKm: 19591 }],
  };

  /* ============================ Canvas palettes ============================ */

  const PALETTES = {
    dark: {
      sky: ["#151a2c", "#0a0d19", "#04050c"],
      star: "223, 230, 246",
      starWarm: "244, 226, 188",
      gold: "#d4af37",
      goldSoft: "rgba(212, 175, 55, 0.5)",
      band: "rgba(212, 175, 55, 0.045)",
      bandHi: "rgba(212, 175, 55, 0.16)",
      spoke: "rgba(212, 175, 55, 0.26)",
      tick: "rgba(205, 212, 228, 0.28)",
      orbit: "rgba(150, 165, 195, 0.22)",
      trail: "rgba(212, 175, 55, 0.4)",
      ink: "#ece7d8",
      muted: "#9aa2b1",
      glyph: "#dcbb52",
      chineseGlyph: "#c9956a",
      halo: "rgba(212, 175, 55, 0.10)",
      moonLit: "#e8e6df",
      moonDark: "rgba(16, 20, 32, 0.85)",
      ring: "rgba(160, 175, 200, 0.35)",
      live: "#4ade80",
      comet: "#7fd8ea",
      asteroid: "#e8a05c",
    },
    light: {
      sky: ["#faf4e4", "#f1e6cc", "#e5d5b2"],
      star: "88, 74, 50",
      starWarm: "120, 95, 45",
      gold: "#8a6d1f",
      goldSoft: "rgba(138, 109, 31, 0.55)",
      band: "rgba(138, 109, 31, 0.06)",
      bandHi: "rgba(138, 109, 31, 0.18)",
      spoke: "rgba(138, 109, 31, 0.32)",
      tick: "rgba(74, 64, 44, 0.35)",
      orbit: "rgba(90, 78, 55, 0.30)",
      trail: "rgba(138, 109, 31, 0.5)",
      ink: "#2a2318",
      muted: "#6d6452",
      glyph: "#7d621c",
      chineseGlyph: "#8b5a2b",
      halo: "rgba(138, 109, 31, 0.10)",
      moonLit: "#f5f1e6",
      moonDark: "rgba(84, 70, 46, 0.65)",
      ring: "rgba(90, 78, 55, 0.42)",
      live: "#15803d",
      comet: "#0e7490",
      asteroid: "#9a5b17",
    },
  };

  const SERIF = '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif';
  const ZODIAC_FONT = '"Cinzel", "Trajan Pro", "Palatino Linotype", Georgia, serif';
  const CHINESE_FONT = '"Noto Serif SC", "Songti SC", "STSong", SimSun, serif';
  const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  const ZODIAC_DATE_RANGES = [
    "Mar 21 – Apr 19", "Apr 20 – May 20", "May 21 – Jun 20", "Jun 21 – Jul 22",
    "Jul 23 – Aug 22", "Aug 23 – Sep 22", "Sep 23 – Oct 22", "Oct 23 – Nov 21",
    "Nov 22 – Dec 21", "Dec 22 – Jan 19", "Jan 20 – Feb 18", "Feb 19 – Mar 20",
  ];

  /* ============================ Astronomy math ============================= */

  function wrapDeg(deg) {
    let d = deg % 360;
    if (d < 0) d += 360;
    return d;
  }

  function julianDay(date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const D = date.getUTCDate()
      + (date.getUTCHours()
        + (date.getUTCMinutes() + date.getUTCSeconds() / 60) / 60) / 24;
    let Y = y;
    let M = m;
    if (M <= 2) { Y -= 1; M += 12; }
    const A = Math.floor(Y / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (Y + 4716))
      + Math.floor(30.6001 * (M + 1)) + D + B - 1524.5;
  }

  function solveKepler(M, e) {
    let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
    for (let i = 0; i < 12; i += 1) {
      const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= dE;
      if (Math.abs(dE) < 1e-8) break;
    }
    return E;
  }

  /** Heliocentric ecliptic position (AU) + ecliptic longitude for a planet. */
  function planetHeliocentric(name, date) {
    const el = PLANET_ELEMENTS[name];
    if (!el) return null;
    const T = (julianDay(date) - 2451545.0) / 36525;
    const a = el.a[0] + el.a[1] * T;
    const e = el.e[0] + el.e[1] * T;
    const I = (el.I[0] + el.I[1] * T) * DEG;
    const L = wrapDeg(el.L[0] + el.L[1] * T) * DEG;
    const wbar = wrapDeg(el.w[0] + el.w[1] * T) * DEG;
    const O = wrapDeg(el.O[0] + el.O[1] * T) * DEG;
    const peri = wbar - O;
    let M = wrapDeg((L - wbar) * RAD) * DEG;
    if (M > Math.PI) M -= TWO_PI;
    const E = solveKepler(M, e);
    const xv = a * (Math.cos(E) - e);
    const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const v = Math.atan2(yv, xv);
    const r = Math.hypot(xv, yv);
    const xh = r * (Math.cos(O) * Math.cos(v + peri) - Math.sin(O) * Math.sin(v + peri) * Math.cos(I));
    const yh = r * (Math.sin(O) * Math.cos(v + peri) + Math.cos(O) * Math.sin(v + peri) * Math.cos(I));
    const zh = r * Math.sin(v + peri) * Math.sin(I);
    return {
      name,
      x: xh, y: yh, z: zh, r,
      lon: wrapDeg(Math.atan2(yh, xh) * RAD),
      period: el.period,
      color: el.color,
      lightColor: el.lightColor,
      size: el.size,
      dwarf: !!el.dwarf,
      type: el.dwarf ? "dwarf_planet" : "planet",
    };
  }

  function geocentricLon(planet, earth) {
    return wrapDeg(Math.atan2(planet.y - earth.y, planet.x - earth.x) * RAD);
  }

  function signFromLon(lon) {
    const d = wrapDeg(lon);
    const idx = Math.floor(d / 30) % 12;
    return { ...ZODIAC[idx], index: idx, degree: d - idx * 30 };
  }

  function chineseSignFromIndex(idx) {
    const i = ((idx % 12) + 12) % 12;
    return { ...CHINESE_ZODIAC[i], index: i };
  }

  function chineseSignFromLon(lon) {
    return chineseSignFromIndex(Math.floor(wrapDeg(lon) / 30) % 12);
  }

  function chineseSignLabel(sign) {
    if (!sign) return "\u2014";
    const yinYang = sign.yin ? "Yin" : "Yang";
    return `${sign.name} \u00B7 ${sign.element} \u00B7 ${yinYang}`;
  }

  // Gregorian Lunar New Year start (month, day) per year, for lunar-year lookups.
  const LUNAR_NEW_YEAR = {
    2018: [2, 16], 2019: [2, 5], 2020: [1, 25], 2021: [2, 12], 2022: [2, 1],
    2023: [1, 22], 2024: [2, 10], 2025: [1, 29], 2026: [2, 17], 2027: [2, 6],
    2028: [1, 26], 2029: [2, 13], 2030: [2, 3],
  };
  const SEXAGENARY_ELEMENTS = ["Wood", "Fire", "Earth", "Metal", "Water"];

  /** Tropical western sun sign for a calendar date (matches the TTS add-on). */
  function westernSunSignByDate(date) {
    const md = (date.getMonth() + 1) * 100 + date.getDate();
    const ranges = [
      [321, 419, 0], [420, 520, 1], [521, 620, 2], [621, 722, 3],
      [723, 822, 4], [823, 922, 5], [923, 1022, 6], [1023, 1121, 7],
      [1122, 1221, 8], [1222, 1231, 9], [101, 119, 9], [120, 218, 10],
      [219, 320, 11],
    ];
    for (const [s, e, idx] of ranges) {
      if (md >= s && md <= e) return { ...ZODIAC[idx], index: idx };
    }
    return { ...ZODIAC[11], index: 11 };
  }

  /** Chinese sexagenary combination (element + animal + polarity) for the
   *  lunar year containing *date*. */
  function chineseYearByDate(date) {
    let year = date.getFullYear();
    const lny = LUNAR_NEW_YEAR[year] || [2, 4];
    if ((date.getMonth() + 1) * 100 + date.getDate() < lny[0] * 100 + lny[1]) {
      year -= 1;
    }
    const stem = (((year - 4) % 10) + 10) % 10;
    const branch = (((year - 4) % 12) + 12) % 12;
    return {
      element: SEXAGENARY_ELEMENTS[Math.floor(stem / 2)],
      animal: CHINESE_ZODIAC[branch].name,
      polarity: stem % 2 === 0 ? "Yang" : "Yin",
      index: branch,
      year,
    };
  }

  /** True geocentric sign of a body as seen from Earth (Earth => Sun's sign). */
  function bodySign(planet, earth) {
    if (planet.name === "Earth") {
      const sunLon = wrapDeg(planet.lon + 180);
      return { sign: signFromLon(sunLon), lon: sunLon, ofSun: true };
    }
    const lon = earth ? geocentricLon(planet, earth) : planet.lon;
    return { sign: signFromLon(lon), lon, ofSun: false };
  }

  /** Is the planet in apparent retrograde (geocentric longitude decreasing)? */
  function isRetrograde(name, date) {
    if (name === "Earth") return false;
    const before = new Date(date.getTime() - 43200000);
    const e0 = planetHeliocentric("Earth", before);
    const e1 = planetHeliocentric("Earth", date);
    const p0 = planetHeliocentric(name, before);
    const p1 = planetHeliocentric(name, date);
    if (!p0 || !p1) return false;
    let d = geocentricLon(p1, e1) - geocentricLon(p0, e0);
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d < 0;
  }

  /** Low-precision Moon: ecliptic longitude, distance (km), phase. */
  function moonState(date) {
    const D = julianDay(date) - 2451545.0;
    const L = wrapDeg(218.316 + 13.176396 * D);
    const M = wrapDeg(134.963 + 13.064993 * D);
    const F = wrapDeg(93.272 + 13.229350 * D);
    const sunM = 357.529 + 0.98560028 * D;
    const lon = wrapDeg(
      L
      + 6.289 * Math.sin(M * DEG)
      + 1.274 * Math.sin((2 * (L - sunM) - M) * DEG)
      + 0.658 * Math.sin(2 * (L - sunM) * DEG)
      + 0.214 * Math.sin(2 * M * DEG)
      - 0.186 * Math.sin(sunM * DEG)
      - 0.114 * Math.sin(2 * F * DEG),
    );
    const distKm = 385001
      - 20905 * Math.cos(M * DEG)
      - 3699 * Math.cos((2 * (L - sunM) - M) * DEG)
      - 2956 * Math.cos(2 * (L - sunM) * DEG);
    const sunLon = wrapDeg(280.460 + 0.9856474 * D);
    const phaseAngle = wrapDeg(lon - sunLon);
    return {
      lon,
      distKm,
      phaseAngle,
      illumination: 0.5 * (1 - Math.cos(phaseAngle * DEG)),
      phaseName: moonPhaseName(phaseAngle),
    };
  }

  function moonPhaseName(phaseAngle) {
    const a = wrapDeg(phaseAngle);
    if (a < 22.5 || a >= 337.5) return "New Moon";
    if (a < 67.5) return "Waxing Crescent";
    if (a < 112.5) return "First Quarter";
    if (a < 157.5) return "Waxing Gibbous";
    if (a < 202.5) return "Full Moon";
    if (a < 247.5) return "Waning Gibbous";
    if (a < 292.5) return "Last Quarter";
    return "Waning Crescent";
  }

  /* =============================== Formatting ============================== */

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtAU(au, digits) {
    if (au == null || !Number.isFinite(Number(au))) return "\u2014";
    return `${Number(au).toFixed(digits == null ? 3 : digits)} AU`;
  }

  function fmtMkm(au) {
    if (au == null || !Number.isFinite(Number(au))) return "";
    const mkm = (Number(au) * AU_KM) / 1e6;
    return `${mkm >= 100 ? Math.round(mkm) : mkm.toFixed(1)} M km`;
  }

  function fmtKm(km) {
    if (km == null || !Number.isFinite(Number(km))) return "\u2014";
    return `${Math.round(Number(km)).toLocaleString()} km`;
  }

  function fmtLD(ld) {
    if (ld == null || !Number.isFinite(Number(ld))) return "\u2014";
    const n = Number(ld);
    return `${n.toFixed(n < 10 ? 2 : 1)} LD`;
  }

  function fmtPeriod(days) {
    if (days == null || !Number.isFinite(Number(days))) return "\u2014";
    const d = Number(days);
    if (d >= 700) return `${(d / 365.25).toFixed(1)} yr`;
    if (d >= 2) return `${d.toFixed(1)} d`;
    return `${(d * 24).toFixed(1)} h`;
  }

  function fmtUTC(date) {
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const mm = String(date.getUTCMinutes()).padStart(2, "0");
    return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} \u00B7 ${hh}:${mm} UTC`;
  }

  function fmtLocal(iso) {
    if (!iso) return "\u2014";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    try {
      return d.toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
    } catch (_) {
      return d.toISOString().slice(0, 16).replace("T", " ");
    }
  }

  function signLabel(sign) {
    if (!sign) return "\u2014";
    return `${sign.glyph}${TS} ${sign.name} ${sign.degree != null ? `${sign.degree.toFixed(1)}\u00B0` : ""}`.trim();
  }

  /* ================================ Styles ================================= */

  const STYLE_ID = "hw-space-atlas-styles";

  const CSS = `
    .hw-space {
      --sm-bg: var(--hw-bg, #07080c);
      --sm-text: var(--hw-text, #ece7d8);
      --sm-muted: var(--hw-muted, #9aa2b1);
      --sm-accent: var(--hw-accent, #d4af37);
      --sm-border: var(--hw-border, rgba(212, 175, 55, 0.24));
      --sm-gold: #d4af37;
      --sm-chinese: #c9956a;
      --sm-panel: rgba(12, 15, 25, 0.88);
      --sm-panel-soft: rgba(12, 15, 25, 0.72);
      --sm-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      background: var(--sm-bg);
      color: var(--sm-text);
      font-family: ${SERIF};
      font-size: 13px;
      line-height: 1.4;
    }
    .hw-space[data-theme="light"] {
      --sm-gold: #8a6d1f;
      --sm-chinese: #8b5a2b;
      --sm-panel: rgba(252, 248, 238, 0.92);
      --sm-panel-soft: rgba(252, 248, 238, 0.8);
      --sm-shadow: 0 8px 24px rgba(80, 64, 30, 0.18);
    }
    .hw-space *, .hw-space *::before, .hw-space *::after { box-sizing: border-box; }
    .hw-space button { font-family: inherit; }
    .hw-space button:focus-visible,
    .hw-space input:focus-visible {
      outline: 2px solid var(--sm-accent, var(--sm-gold));
      outline-offset: 2px;
    }

    .sm-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; }
    .sm-canvas {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
      cursor: grab;
    }
    .sm-canvas:active { cursor: grabbing; }
    .sm-canvas:focus-visible { outline: 2px solid var(--sm-gold); outline-offset: -3px; }

    /* ---- top bar ---- */
    .sm-topbar {
      position: absolute;
      top: 8px; left: 8px; right: 8px;
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 8px;
      z-index: 4;
      pointer-events: none;
    }
    .sm-topbar > * { pointer-events: auto; }
    .sm-spacer { flex: 1; pointer-events: none; }

    .sm-seg {
      display: inline-flex;
      border: 1px solid var(--sm-border);
      border-radius: 999px;
      overflow: hidden;
      background: var(--sm-panel-soft);
      backdrop-filter: blur(8px);
      box-shadow: var(--sm-shadow);
    }
    .sm-seg button + button {
      border-left: 1px solid var(--sm-border);
    }
    .sm-seg button {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--sm-muted);
      font-size: 12.5px;
      letter-spacing: 0.06em;
      padding: 0 16px;
      min-height: 44px;
      cursor: pointer;
      white-space: nowrap;
      transition: color 120ms ease, background 120ms ease;
    }
    .sm-seg button[aria-pressed="true"] {
      color: var(--sm-text);
      background: color-mix(in srgb, var(--sm-gold) 20%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sm-gold) 55%, transparent);
    }

    .sm-chip {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 44px;
      padding: 0 14px;
      border: 1px solid var(--sm-border);
      border-radius: 999px;
      background: var(--sm-panel-soft);
      backdrop-filter: blur(8px);
      color: var(--sm-text);
      font-size: 12px;
      letter-spacing: 0.04em;
      cursor: pointer;
      box-shadow: var(--sm-shadow);
      white-space: nowrap;
    }
    .sm-chip .sm-chip-glyph { color: var(--sm-gold); font-size: 14px; }
    .sm-chip[aria-expanded="true"] {
      background: color-mix(in srgb, var(--sm-gold) 18%, var(--sm-panel-soft));
    }
    .sm-chip[hidden] { display: none !important; }

    /* Zodiac chip: western + Chinese year with themed fonts */
    .sm-chip-zodiac { gap: 9px; padding: 0 16px; }
    .sm-chip-z-title {
      font-family: ${ZODIAC_FONT};
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: var(--sm-gold);
      opacity: 0.9;
      padding-right: 2px;
      border-right: 1px solid var(--sm-border);
    }
    .sm-chip-z-west {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-family: ${ZODIAC_FONT};
      font-weight: 500;
      letter-spacing: 0.05em;
      color: var(--sm-text);
    }
    .sm-chip-z-west .sm-chip-z-glyph { color: var(--sm-gold); font-size: 15px; }
    .sm-chip-z-dot { color: var(--sm-muted); opacity: 0.6; }
    .sm-chip-z-cn {
      font-family: ${CHINESE_FONT};
      font-weight: 600;
      letter-spacing: 0.08em;
      color: var(--sm-chinese);
    }

    /* ---- drawer (lists) ---- */
    .sm-drawer {
      position: absolute;
      top: 60px;
      left: 8px;
      width: min(300px, calc(100% - 16px));
      max-height: calc(52% - 30px);
      display: flex;
      flex-direction: column;
      z-index: 3;
      border: 1px solid var(--sm-border);
      border-radius: 14px;
      background: var(--sm-panel);
      backdrop-filter: blur(10px);
      box-shadow: var(--sm-shadow);
      overflow: hidden;
    }
    .sm-drawer[hidden] { display: none !important; }
    .sm-drawer-scroll { overflow-y: auto; min-height: 0; padding: 4px 0 8px; }
    .sm-drawer h3 {
      margin: 0;
      padding: 12px 14px 8px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--sm-gold);
    }
    .sm-drawer h3 .sm-count { color: var(--sm-muted); letter-spacing: 0.05em; }
    .sm-row {
      display: block;
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      color: inherit;
      font-size: 12.5px;
      padding: 9px 14px;
      min-height: 44px;
      cursor: pointer;
    }
    .sm-row:hover { background: color-mix(in srgb, var(--sm-gold) 9%, transparent); }
    .sm-row strong { display: block; font-weight: 600; font-size: 13px; }
    .sm-row .sm-sub { display: block; color: var(--sm-muted); font-size: 11.5px; margin-top: 1px; }
    .sm-row.sm-pinned {
      border-left: 3px solid var(--sm-gold);
      background: color-mix(in srgb, var(--sm-gold) 8%, transparent);
    }
    .sm-tag {
      display: inline-block;
      font-size: 9.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--sm-gold);
      border: 1px solid color-mix(in srgb, var(--sm-gold) 50%, transparent);
      border-radius: 4px;
      padding: 1px 5px;
      margin-left: 6px;
      vertical-align: 1px;
    }
    .sm-tag.sm-live { color: var(--sm-live-c, #4ade80); border-color: currentColor; }
    .hw-space[data-theme="light"] .sm-tag.sm-live { --sm-live-c: #15803d; }
    .sm-empty {
      padding: 10px 14px 14px;
      color: var(--sm-muted);
      font-size: 12px;
      line-height: 1.5;
    }
    .sm-empty .sm-empty-glyph {
      display: block;
      font-size: 22px;
      color: color-mix(in srgb, var(--sm-gold) 65%, transparent);
      margin-bottom: 6px;
    }
    .sm-foot {
      padding: 8px 14px 12px;
      font-size: 10px;
      letter-spacing: 0.06em;
      color: var(--sm-muted);
      border-top: 1px solid var(--sm-border);
    }

    /* ---- info card ---- */
    .sm-card {
      position: absolute;
      left: 8px;
      bottom: 8px;
      width: min(320px, calc(100% - 72px));
      max-height: 52%;
      overflow-y: auto;
      z-index: 5;
      border: 1px solid var(--sm-border);
      border-radius: 14px;
      background: var(--sm-panel);
      backdrop-filter: blur(10px);
      box-shadow: var(--sm-shadow);
      padding: 14px 16px 12px;
    }
    .sm-card[hidden] { display: none !important; }
    .sm-card-head { display: flex; align-items: baseline; gap: 8px; padding-right: 40px; }
    .sm-card-glyph { font-size: 20px; color: var(--sm-gold); line-height: 1; }
    .sm-card h4 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: 0.02em; }
    .sm-card .sm-kind {
      margin: 2px 0 10px;
      font-size: 10.5px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--sm-muted);
    }
    .sm-card .sm-kv {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      padding: 4px 0;
      font-size: 12.5px;
      border-top: 1px solid color-mix(in srgb, var(--sm-border) 55%, transparent);
    }
    .sm-card .sm-kv:first-of-type { border-top: 0; }
    .sm-card .sm-kv > span { color: var(--sm-muted); flex-shrink: 0; }
    .sm-card .sm-kv > strong { font-weight: 600; text-align: right; }
    .sm-card .sm-note {
      margin-top: 8px;
      font-size: 11px;
      font-style: italic;
      color: var(--sm-muted);
      line-height: 1.45;
    }
    .sm-card .sm-close {
      position: absolute;
      top: 4px; right: 4px;
      min-width: 44px; min-height: 44px;
      border: 0;
      background: transparent;
      color: var(--sm-muted);
      font-size: 20px;
      cursor: pointer;
      border-radius: 10px;
    }
    .sm-card .sm-close:hover { color: var(--sm-text); }
    .sm-card--western {
      border-color: color-mix(in srgb, var(--sm-gold) 55%, transparent);
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(212, 175, 55, 0.12);
    }
    .sm-card--western .sm-card-head h4 {
      font-family: ${ZODIAC_FONT};
      letter-spacing: 0.08em;
    }
    .sm-card--chinese {
      border-color: color-mix(in srgb, #c9956a 55%, transparent);
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(201, 149, 106, 0.12);
    }
    .sm-card--chinese .sm-card-head h4 {
      font-family: ${CHINESE_FONT};
      letter-spacing: 0.12em;
    }

    /* ---- zoom controls ---- */
    .sm-zoom {
      position: absolute;
      right: 8px;
      bottom: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      z-index: 4;
    }
    .sm-zoom button {
      width: 44px; height: 44px;
      border-radius: 999px;
      border: 1px solid var(--sm-border);
      background: var(--sm-panel-soft);
      backdrop-filter: blur(8px);
      color: var(--sm-text);
      font-size: 17px;
      line-height: 1;
      cursor: pointer;
      box-shadow: var(--sm-shadow);
    }
    .sm-zoom button:hover { background: color-mix(in srgb, var(--sm-gold) 14%, var(--sm-panel-soft)); }

    /* ---- hint ---- */
    .sm-hint {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: 10px;
      z-index: 2;
      pointer-events: none;
      font-size: 11px;
      font-style: italic;
      letter-spacing: 0.03em;
      color: var(--sm-muted);
      background: var(--sm-panel-soft);
      border: 1px solid var(--sm-border);
      border-radius: 999px;
      padding: 5px 14px;
      white-space: nowrap;
    }
    @media (max-width: 640px) { .sm-hint { display: none; } }

    /* ---- time footer ---- */
    .sm-footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-top: 1px solid var(--sm-border);
      background: color-mix(in srgb, var(--sm-bg) 86%, transparent);
      z-index: 6;
    }
    .sm-footer .sm-btn {
      min-height: 44px;
      min-width: 48px;
      padding: 0 12px;
      border: 1px solid var(--sm-border);
      border-radius: 10px;
      background: transparent;
      color: var(--sm-text);
      font-size: 12px;
      letter-spacing: 0.04em;
      cursor: pointer;
      white-space: nowrap;
    }
    .sm-footer .sm-btn:hover { background: color-mix(in srgb, var(--sm-gold) 12%, transparent); }
    .sm-footer input[type="range"] {
      flex: 1;
      min-width: 90px;
      height: 32px;
      accent-color: var(--sm-gold);
      cursor: pointer;
    }
    .sm-timeinfo {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      min-width: 118px;
      margin-left: auto;
    }
    .sm-timeoffset { font-size: 12.5px; font-weight: 600; color: var(--sm-gold); letter-spacing: 0.04em; }
    .sm-timedate { font-size: 10.5px; color: var(--sm-muted); letter-spacing: 0.04em; }

    .sm-sr {
      position: absolute;
      width: 1px; height: 1px;
      margin: -1px; padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }

    @media (max-width: 480px) {
      .sm-drawer { max-height: 46%; width: calc(100% - 16px); top: 108px; }
      .sm-card { width: calc(100% - 68px); max-height: 46%; }
      .sm-timeinfo { min-width: 100px; }
    }
  `;

  function injectStyles(rootNode) {
    const isShadow = rootNode && typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot;
    const target = isShadow ? rootNode : document.head;
    if (target.querySelector(`#${STYLE_ID}`)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    target.appendChild(style);
  }

  /* ================================ Viewport =============================== */

  class Viewport {
    constructor() {
      this.x = 0;
      this.y = 0;
      this.zoom = 1;
      this.minZoom = 0.5;
      this.maxZoom = 14;
    }

    reset() { this.x = 0; this.y = 0; this.zoom = 1; }

    zoomBy(factor, cx, cy, width, height) {
      const prev = this.zoom;
      this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
      if (cx != null && cy != null && width && height) {
        const ux = (cx - width / 2 - this.x) / prev;
        const uy = (cy - height / 2 - this.y) / prev;
        this.x = cx - width / 2 - ux * this.zoom;
        this.y = cy - height / 2 - uy * this.zoom;
      }
    }

    pan(dx, dy) { this.x += dx; this.y += dy; }
  }

  /* ================================ SpaceMap =============================== */

  class SpaceMap {
    constructor(options = {}) {
      this._hass = options.hass || null;
      this._shadowRoot = options.shadowRoot || null;
      this._root = options.root || null;
      this._onModeChange = typeof options.onModeChange === "function" ? options.onModeChange : null;
      this._mode = this._normalizeMode(options.mode || "solar_system");
      this._layers = Object.assign({
        planets: true,
        dwarf_planets: true,
        moons: true,
        spacecraft: true,
        asteroids: true,
        comets: true,
      }, options.layers || {});
      this._logScale = options.logScale !== false;
      this._theme = options.theme || null;

      this._mapData = null;
      this._solarData = null;
      this._lastUpdatedISO = null;
      this._offsetDays = 0;

      this._vp = new Viewport();
      this._canvas = null;
      this._ctx = null;
      this._dpr = 1;
      this._raf = null;
      this._dirty = true;
      this._stars = null;
      this._twinkle = 0;
      this._twinkleTimer = null;
      this._resizeObs = null;

      this._pickables = [];
      this._selectedId = null;
      this._selectedData = null;
      this._drawerOpen = null; // null = auto by width
      this._pointers = new Map();
      this._pinchDist = 0;
      this._dragMoved = false;
      this._lastX = 0;
      this._lastY = 0;

      this._reducedMotion = false;
      this._motionQuery = null;

      this._onPointerDown = this._handlePointerDown.bind(this);
      this._onPointerMove = this._handlePointerMove.bind(this);
      this._onPointerUp = this._handlePointerUp.bind(this);
      this._onWheel = this._handleWheel.bind(this);
      this._onKeyDown = this._handleKeyDown.bind(this);
      this._onWinResize = () => this._resizeCanvas();
    }

    /* ------------------------------ public API ----------------------------- */

    mount() {
      if (!this._root) return;
      injectStyles(this._root.getRootNode ? this._root.getRootNode() : document);
      try {
        this._motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
        this._reducedMotion = !!this._motionQuery.matches;
        this._motionHandler = () => {
          this._reducedMotion = !!this._motionQuery.matches;
          this._syncTwinkle();
        };
        if (this._motionQuery.addEventListener) this._motionQuery.addEventListener("change", this._motionHandler);
      } catch (_) { /* matchMedia unavailable */ }

      this._buildShell();
      this._resizeCanvas();
      this._renderDrawer();
      this._renderChip();
      this.loadData();

      if (typeof ResizeObserver !== "undefined") {
        this._resizeObs = new ResizeObserver(() => this._resizeCanvas());
        this._resizeObs.observe(this._root);
      } else {
        window.addEventListener("resize", this._onWinResize);
      }
      this._syncTwinkle();
      this._raf = requestAnimationFrame(() => this._tick());
    }

    destroy() {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
      if (this._twinkleTimer) clearInterval(this._twinkleTimer);
      this._twinkleTimer = null;
      if (this._resizeObs) this._resizeObs.disconnect();
      this._resizeObs = null;
      window.removeEventListener("resize", this._onWinResize);
      if (this._motionQuery && this._motionQuery.removeEventListener && this._motionHandler) {
        this._motionQuery.removeEventListener("change", this._motionHandler);
      }
      this._unbindCanvas();
      if (this._root) this._root.innerHTML = "";
      this._canvas = null;
      this._ctx = null;
    }

    setMode(mode) {
      const next = this._normalizeMode(mode);
      if (next === this._mode) return;
      this._mode = next;
      this._vp.reset();
      this._select(null, { silent: true });
      this._syncSeg();
      this._renderDrawer();
      this._renderChip();
      this._dirty = true;
    }

    setLayers(layers) {
      this._layers = Object.assign({}, this._layers, layers || {});
      this._renderDrawer();
      this._dirty = true;
    }

    setLogScale(enabled) {
      this._logScale = enabled !== false;
      this._dirty = true;
    }

    setTheme(mode) {
      this._theme = mode === "light" ? "light" : "dark";
      const el = this._el(".hw-space");
      if (el) el.setAttribute("data-theme", this._theme);
      this._stars = null;
      this._dirty = true;
    }

    getLastUpdated() {
      if (!this._lastUpdatedISO) return null;
      const d = new Date(this._lastUpdatedISO);
      if (Number.isNaN(d.getTime())) return this._lastUpdatedISO;
      try {
        return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      } catch (_) {
        return this._lastUpdatedISO;
      }
    }

    async loadData() {
      if (!this._hass) return;
      try {
        const [mapPayload, solarPayload] = await Promise.all([
          this._hass.callWS({ type: "home_weather/get_space_map" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_solar_weather" }).catch(() => null),
        ]);
        this._mapData = mapPayload || this._mapData || {};
        this._solarData = (solarPayload && solarPayload.solar_weather)
          || (mapPayload && mapPayload.solar_weather)
          || this._solarData
          || null;
        this._lastUpdatedISO = (mapPayload && mapPayload.updated)
          || (solarPayload && solarPayload.updated)
          || this._lastUpdatedISO;
        this._renderDrawer();
        this._renderChip();
        this._dirty = true;
      } catch (err) {
        console.warn("[space-map] data load failed", err);
      }
    }

    /* ------------------------------ shell / DOM ----------------------------- */

    _normalizeMode(mode) {
      if (mode === "earth" || mode === "earth_mode") return "earth";
      if (mode === "sun" || mode === "sun_weather") return "sun";
      return "solar_system";
    }

    _el(sel) {
      return this._root ? this._root.querySelector(sel) : null;
    }

    _resolveTheme() {
      if (this._theme) return this._theme;
      const fromRoot = this._root && this._root.getAttribute && this._root.getAttribute("data-hw-theme");
      const host = this._shadowRoot && this._shadowRoot.host;
      const fromHost = host && host.getAttribute && host.getAttribute("data-hw-theme");
      return fromRoot || fromHost || "dark";
    }

    _palette() {
      return this._resolveTheme() === "light" ? PALETTES.light : PALETTES.dark;
    }

    _buildShell() {
      const theme = this._resolveTheme();
      this._theme = theme;
      this._root.innerHTML = `
        <div class="hw-space" data-theme="${esc(theme)}">
          <div class="sm-stage">
            <canvas class="sm-canvas" tabindex="0" role="application"
              aria-label="Celestial atlas. Interactive chart of the ${this._mode === "earth" ? "Earth system" : this._mode === "sun" ? "Sun and solar weather" : "solar system"}."
              aria-describedby="sm-kbd-help"></canvas>
            <div id="sm-kbd-help" class="sm-sr">
              Arrow keys pan. Plus and minus zoom. Zero resets the view.
              N and P cycle through bodies. Escape closes details.
            </div>
            <div class="sm-topbar">
              <div class="sm-seg" role="group" aria-label="Chart mode">
                <button type="button" data-sm-mode="solar_system"
                  aria-pressed="${this._mode === "solar_system"}">Solar System</button>
                <button type="button" data-sm-mode="earth"
                  aria-pressed="${this._mode === "earth"}">Earth</button>
                <button type="button" data-sm-mode="sun"
                  aria-pressed="${this._mode === "sun"}">Sun</button>
              </div>
              <button type="button" class="sm-chip" data-sm="drawer-toggle"
                aria-expanded="false" aria-controls="sm-drawer"></button>
              <div class="sm-spacer"></div>
              <button type="button" class="sm-chip" data-sm="solar-chip" hidden></button>
            </div>
            <aside class="sm-drawer" id="sm-drawer" hidden></aside>
            <div class="sm-card" data-sm="card" hidden aria-live="polite"></div>
            <div class="sm-zoom">
              <button type="button" data-sm="zoom-in" aria-label="Zoom in">+</button>
              <button type="button" data-sm="zoom-out" aria-label="Zoom out">\u2212</button>
              <button type="button" data-sm="zoom-reset" aria-label="Reset view">\u2316</button>
            </div>
            <div class="sm-hint">Drag to pan \u00B7 pinch or scroll to zoom \u00B7 tap a body for details</div>
            <div class="sm-sr" data-sm="announce" aria-live="polite"></div>
          </div>
          <div class="sm-footer">
            <button type="button" class="sm-btn" data-sm="time-back" aria-label="Back one day">\u22121 d</button>
            <input type="range" min="-7" max="7" step="0.25" value="0" data-sm="time-range"
              aria-label="Time offset in days, minus seven to plus seven" />
            <button type="button" class="sm-btn" data-sm="time-fwd" aria-label="Forward one day">+1 d</button>
            <button type="button" class="sm-btn" data-sm="time-now">Now</button>
            <div class="sm-timeinfo">
              <span class="sm-timeoffset" data-sm="time-offset">Now</span>
              <span class="sm-timedate" data-sm="time-date"></span>
            </div>
          </div>
        </div>`;

      this._canvas = this._el(".sm-canvas");
      this._ctx = this._canvas.getContext("2d");
      this._bindCanvas();

      this._root.querySelectorAll("[data-sm-mode]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = btn.getAttribute("data-sm-mode");
          this.setMode(mode);
          if (this._onModeChange) {
            try { this._onModeChange(this._mode); } catch (_) { /* panel hook */ }
          }
        });
      });

      this._el('[data-sm="drawer-toggle"]').addEventListener("click", () => {
        this._drawerOpen = !this._isDrawerOpen();
        this._syncDrawerVisibility();
      });
      this._el('[data-sm="zoom-in"]').addEventListener("click", () => { this._zoomCenter(1.3); });
      this._el('[data-sm="zoom-out"]').addEventListener("click", () => { this._zoomCenter(1 / 1.3); });
      this._el('[data-sm="zoom-reset"]').addEventListener("click", () => {
        this._vp.reset();
        this._dirty = true;
      });
      this._el('[data-sm="solar-chip"]').addEventListener("click", () => {
        const w = westernSunSignByDate(this._date());
        this._select({
          id: `zodiac:western:${w.index}`, kind: "western_zodiac", index: w.index,
          sx: -1e4, sy: -1e4, hit: 0, label: w.name,
        });
      });

      const range = this._el('[data-sm="time-range"]');
      range.addEventListener("input", () => this._setOffset(Number(range.value) || 0, false));
      this._el('[data-sm="time-back"]').addEventListener("click", () => this._setOffset(this._offsetDays - 1, true));
      this._el('[data-sm="time-fwd"]').addEventListener("click", () => this._setOffset(this._offsetDays + 1, true));
      this._el('[data-sm="time-now"]').addEventListener("click", () => this._setOffset(0, true));
      this._updateTimeReadout();
    }

    _syncSeg() {
      this._root.querySelectorAll("[data-sm-mode]").forEach((btn) => {
        btn.setAttribute("aria-pressed", String(btn.getAttribute("data-sm-mode") === this._mode));
      });
      const canvas = this._canvas;
      if (canvas) {
        canvas.setAttribute("aria-label",
          `Celestial atlas. Interactive chart of the ${this._mode === "earth" ? "Earth system" : this._mode === "sun" ? "Sun and solar weather" : "solar system"}.`);
      }
    }

    _isDrawerOpen() {
      if (this._drawerOpen != null) return this._drawerOpen;
      const stage = this._el(".sm-stage");
      return !!stage && stage.clientWidth >= 720;
    }

    _syncDrawerVisibility() {
      const drawer = this._el("#sm-drawer");
      const toggle = this._el('[data-sm="drawer-toggle"]');
      if (!drawer || !toggle) return;
      const open = this._isDrawerOpen();
      drawer.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    }

    _setOffset(days, syncRange) {
      this._offsetDays = Math.min(7, Math.max(-7, days));
      if (syncRange) {
        const range = this._el('[data-sm="time-range"]');
        if (range) range.value = String(this._offsetDays);
      }
      this._updateTimeReadout();
      this._renderChip();
      if (this._selectedData) this._refreshCard();
      this._dirty = true;
    }

    _updateTimeReadout() {
      const off = this._el('[data-sm="time-offset"]');
      const dateEl = this._el('[data-sm="time-date"]');
      if (off) {
        off.textContent = this._offsetDays === 0
          ? "Now"
          : `${this._offsetDays > 0 ? "+" : "\u2212"}${Math.abs(this._offsetDays).toFixed(2).replace(/\.?0+$/, "")} d`;
      }
      if (dateEl) dateEl.textContent = fmtUTC(this._date());
    }

    _date() {
      return new Date(Date.now() + this._offsetDays * 86400000);
    }

    _announce(text) {
      const region = this._el('[data-sm="announce"]');
      if (region) region.textContent = text || "";
    }

    /* -------------------------------- canvas -------------------------------- */

    _bindCanvas() {
      const c = this._canvas;
      c.addEventListener("pointerdown", this._onPointerDown);
      c.addEventListener("pointermove", this._onPointerMove);
      c.addEventListener("pointerup", this._onPointerUp);
      c.addEventListener("pointercancel", this._onPointerUp);
      c.addEventListener("wheel", this._onWheel, { passive: false });
      c.addEventListener("keydown", this._onKeyDown);
    }

    _unbindCanvas() {
      const c = this._canvas;
      if (!c) return;
      c.removeEventListener("pointerdown", this._onPointerDown);
      c.removeEventListener("pointermove", this._onPointerMove);
      c.removeEventListener("pointerup", this._onPointerUp);
      c.removeEventListener("pointercancel", this._onPointerUp);
      c.removeEventListener("wheel", this._onWheel);
      c.removeEventListener("keydown", this._onKeyDown);
    }

    _resizeCanvas() {
      const stage = this._el(".sm-stage");
      if (!stage || !this._canvas) return;
      const w = Math.max(stage.clientWidth, 240);
      const h = Math.max(stage.clientHeight, 200);
      this._dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      this._canvas.width = Math.floor(w * this._dpr);
      this._canvas.height = Math.floor(h * this._dpr);
      this._stars = null;
      this._syncDrawerVisibility();
      this._dirty = true;
    }

    _syncTwinkle() {
      if (this._twinkleTimer) {
        clearInterval(this._twinkleTimer);
        this._twinkleTimer = null;
      }
      if (this._reducedMotion) return;
      this._twinkleTimer = setInterval(() => {
        if (document.hidden) return;
        this._twinkle += 0.55;
        this._dirty = true;
      }, 600);
    }

    _tick() {
      if (this._dirty) {
        this._dirty = false;
        this._draw();
      }
      this._raf = requestAnimationFrame(() => this._tick());
    }

    _zoomCenter(factor) {
      const rect = this._canvas.getBoundingClientRect();
      this._vp.zoomBy(factor, rect.width / 2, rect.height / 2, rect.width, rect.height);
      this._dirty = true;
    }

    /* ------------------------------- rendering ------------------------------ */

    _draw() {
      if (!this._ctx || !this._canvas) return;
      const ctx = this._ctx;
      const w = this._canvas.width / this._dpr;
      const h = this._canvas.height / this._dpr;
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      this._drawSky(ctx, w, h);
      this._pickables = [];
      this._zodiacRing = null;
      if (this._mode === "earth") this._drawEarthMode(ctx, w, h);
      else if (this._mode === "sun") this._drawSunMode(ctx, w, h);
      else this._drawSolarMode(ctx, w, h);
      this._drawSelection(ctx);
    }

    _drawSky(ctx, w, h) {
      const pal = this._palette();
      const g = ctx.createRadialGradient(w * 0.5, h * 0.42, 12, w * 0.5, h * 0.5, Math.max(w, h) * 0.8);
      g.addColorStop(0, pal.sky[0]);
      g.addColorStop(0.55, pal.sky[1]);
      g.addColorStop(1, pal.sky[2]);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      if (!this._stars) this._stars = this._makeStars(w, h);
      const tw = this._twinkle;
      for (const s of this._stars) {
        const alpha = this._reducedMotion
          ? s.a
          : s.a * (0.72 + 0.28 * Math.sin(tw + s.p));
        ctx.globalAlpha = Math.max(0.06, alpha);
        ctx.fillStyle = `rgb(${s.warm ? pal.starWarm : pal.star})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, TWO_PI);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    _makeStars(w, h) {
      const light = this._resolveTheme() === "light";
      const count = light ? 60 : Math.min(220, Math.round((w * h) / 3600));
      const stars = [];
      let seed = 987654321;
      const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      for (let i = 0; i < count; i += 1) {
        stars.push({
          x: rnd() * w,
          y: rnd() * h,
          r: rnd() > 0.9 ? 1.2 : 0.7,
          a: light ? 0.12 + rnd() * 0.2 : 0.2 + rnd() * 0.5,
          p: rnd() * TWO_PI,
          warm: rnd() > 0.82,
        });
      }
      return stars;
    }

    /** Screen position for polar world coords (ecliptic lon deg, radius units). */
    _polar(cx, cy, k, lonDeg, radiusUnits) {
      const a = lonDeg * DEG;
      return {
        x: cx + Math.cos(a) * radiusUnits * k,
        y: cy - Math.sin(a) * radiusUnits * k,
      };
    }

    _orbitRadiusUnits(au) {
      const d = Math.max(0.0001, Number(au) || 0.0001);
      if (!this._logScale) return 10 + d * 7.2;
      return 26 + Math.log10(1 + d * 14) * 62;
    }

    _strokeArcLon(ctx, cx, cy, rPx, lonStart, lonEnd) {
      // Canvas y-down: ecliptic lon L maps to canvas angle -L.
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, -lonStart * DEG, -lonEnd * DEG, true);
      ctx.stroke();
    }

    _annulusSector(ctx, cx, cy, r0, r1, lon0, lon1) {
      ctx.beginPath();
      ctx.arc(cx, cy, r1, -lon0 * DEG, -lon1 * DEG, true);
      ctx.arc(cx, cy, r0, -lon1 * DEG, -lon0 * DEG, false);
      ctx.closePath();
    }

    /** Split a label into short arc-friendly lines. */
    _wrapArcLabel(text, maxChars = 8) {
      const words = String(text || "").trim().split(/\s+/).filter(Boolean);
      if (!words.length) return [""];
      if (words.length > 1) return words;
      const word = words[0];
      if (word.length <= maxChars) return [word];
      const mid = Math.ceil(word.length / 2);
      return [word.slice(0, mid), word.slice(mid)];
    }

    /** Draw one or more lines of text along a circular arc (ecliptic longitude mid-point). */
    _drawArcText(ctx, cx, cy, radiusPx, lonMidDeg, spanDeg, lines, opts = {}) {
      const pal = this._palette();
      const font = opts.font || SERIF;
      const size = opts.size || 10;
      const color = opts.color || pal.glyph;
      const weight = opts.weight || 500;
      const lineGap = opts.lineGap || 1.2;
      const lineList = Array.isArray(lines) ? lines.filter(Boolean) : [String(lines || "")];

      lineList.forEach((line, lineIdx) => {
        const chars = String(line).split("");
        if (!chars.length) return;
        ctx.save();
        ctx.font = `${weight} ${size}px ${font}`;
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const charWidths = chars.map((ch) => ctx.measureText(ch).width);
        const totalWidth = charWidths.reduce((sum, w) => sum + w, 0);
        const arcLen = Math.max(8, spanDeg * DEG * radiusPx);
        const scale = totalWidth > arcLen * 0.9 ? (arcLen * 0.9) / totalWidth : 1;
        const r = radiusPx - (lineList.length - 1 - lineIdx) * size * lineGap;
        let angle = lonMidDeg * DEG - (totalWidth * scale) / (2 * r);
        for (let i = 0; i < chars.length; i += 1) {
          const w = charWidths[i] * scale;
          const a = angle + w / (2 * r);
          const x = cx + Math.cos(a) * r;
          const y = cy - Math.sin(a) * r;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(Math.PI / 2 - a);
          ctx.fillText(chars[i], 0, 0);
          ctx.restore();
          angle += w / r;
        }
        ctx.restore();
      });
    }

    _pickZodiacAt(sx, sy) {
      const z = this._zodiacRing;
      if (!z) return null;
      const dx = sx - z.cx;
      const dy = sy - z.cy;
      const dist = Math.hypot(dx, dy);
      if (dist < z.innerPx || dist > z.chineseOuter) return null;
      let lon = wrapDeg(Math.atan2(-dy, dx) * RAD);
      const idx = Math.floor(lon / 30) % 12;
      const midLon = idx * 30 + 15;
      const midRad = midLon * DEG;
      const isChinese = dist >= z.chineseInner;
      const midPx = isChinese ? z.chineseMid : z.midPx;
      const sxHit = z.cx + Math.cos(midRad) * midPx;
      const syHit = z.cy - Math.sin(midRad) * midPx;
      return {
        id: isChinese ? `zodiac:chinese:${idx}` : `zodiac:western:${idx}`,
        kind: isChinese ? "chinese_zodiac" : "western_zodiac",
        index: idx,
        sx: sxHit,
        sy: syHit,
        hit: Math.max(22, (isChinese ? z.chineseOuter - z.chineseInner : z.outerPx - z.innerPx) * 0.45),
        label: isChinese ? CHINESE_ZODIAC[idx].name : ZODIAC[idx].name,
      };
    }

    /** The zodiac band — the signature ornament of both modes. */
    _drawZodiacBand(ctx, cx, cy, innerPx, outerPx, highlightIdx) {
      const pal = this._palette();
      const midPx = (innerPx + outerPx) / 2;
      const bandPx = outerPx - innerPx;

      const chineseBandWidth = Math.max(18, bandPx * 0.55);
      const chineseInner = outerPx + 2;
      const chineseOuter = chineseInner + chineseBandWidth;
      const chineseMid = (chineseInner + chineseOuter) / 2;

      this._zodiacRing = {
        cx, cy, innerPx, outerPx, midPx, chineseInner, chineseOuter, chineseMid,
      };

      for (let i = 0; i < 12; i += 1) {
        const lon0 = i * 30;
        const lon1 = lon0 + 30;
        this._annulusSector(ctx, cx, cy, innerPx, outerPx, lon0, lon1);
        if (i === highlightIdx) ctx.fillStyle = pal.bandHi;
        else if (i % 2 === 0) ctx.fillStyle = pal.band;
        else ctx.fillStyle = "transparent";
        if (i === highlightIdx || i % 2 === 0) ctx.fill();
      }

      ctx.lineWidth = 1.4;
      ctx.strokeStyle = pal.goldSoft;
      ctx.beginPath(); ctx.arc(cx, cy, outerPx, 0, TWO_PI); ctx.stroke();
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(cx, cy, innerPx, 0, TWO_PI); ctx.stroke();

      for (let d = 0; d < 360; d += 10) {
        const a = d * DEG;
        const isSpoke = d % 30 === 0;
        const rIn = isSpoke ? innerPx : outerPx - Math.max(4, bandPx * 0.22);
        ctx.strokeStyle = isSpoke ? pal.spoke : pal.tick;
        ctx.lineWidth = isSpoke ? 1 : 0.7;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * rIn, cy - Math.sin(a) * rIn);
        ctx.lineTo(cx + Math.cos(a) * outerPx, cy - Math.sin(a) * outerPx);
        ctx.stroke();
      }

      const glyphSize = Math.max(9, Math.min(14, bandPx * 0.42));
      const nameSize = Math.max(7, Math.min(10, bandPx * 0.28));
      for (let i = 0; i < 12; i += 1) {
        const midLon = i * 30 + 15;
        const hi = i === highlightIdx;
        this._drawArcText(ctx, cx, cy, midPx - nameSize * 0.35, midLon, 24,
          [ZODIAC[i].glyph + TS], {
            font: ZODIAC_FONT,
            size: hi ? glyphSize + 1 : glyphSize,
            color: hi ? pal.gold : pal.glyph,
            weight: 600,
          });
        this._drawArcText(ctx, cx, cy, midPx + nameSize * 0.55, midLon, 26,
          this._wrapArcLabel(ZODIAC[i].name, bandPx >= 22 ? 9 : 7), {
            font: ZODIAC_FONT,
            size: nameSize,
            color: hi ? pal.gold : pal.muted,
            weight: 500,
          });
      }

      for (let i = 0; i < 12; i += 1) {
        const lon0 = i * 30;
        const lon1 = lon0 + 30;
        this._annulusSector(ctx, cx, cy, chineseInner, chineseOuter, lon0, lon1);
        if (CHINESE_ZODIAC[i].yin) {
          ctx.fillStyle = pal.band;
          ctx.globalAlpha = 0.5;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      ctx.lineWidth = 1.2;
      ctx.strokeStyle = pal.goldSoft;
      ctx.beginPath(); ctx.arc(cx, cy, chineseOuter, 0, TWO_PI); ctx.stroke();
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = pal.tick;
      ctx.beginPath(); ctx.arc(cx, cy, chineseInner, 0, TWO_PI); ctx.stroke();

      for (let d = 0; d < 360; d += 30) {
        const a = d * DEG;
        ctx.strokeStyle = pal.tick;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * chineseInner, cy - Math.sin(a) * chineseInner);
        ctx.lineTo(cx + Math.cos(a) * chineseOuter, cy - Math.sin(a) * chineseOuter);
        ctx.stroke();
      }

      const chineseNameSize = Math.max(7, Math.min(10, chineseBandWidth * 0.24));
      for (let i = 0; i < 12; i += 1) {
        const midLon = i * 30 + 15;
        this._drawArcText(ctx, cx, cy, chineseMid, midLon, 24,
          this._wrapArcLabel(CHINESE_ZODIAC[i].name.toUpperCase(), chineseBandWidth >= 28 ? 8 : 6), {
            font: CHINESE_FONT,
            size: chineseNameSize,
            color: pal.chineseGlyph || "#c9956a",
            weight: 600,
          });
      }
    }

    _drawSun(ctx, x, y) {
      const pal = this._palette();
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 30);
      glow.addColorStop(0, "rgba(255, 236, 170, 0.85)");
      glow.addColorStop(0.35, "rgba(255, 196, 84, 0.4)");
      glow.addColorStop(1, "rgba(255, 150, 40, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(x, y, 30, 0, TWO_PI); ctx.fill();

      // Atlas-style rays: 12 hairlines, alternating length
      ctx.strokeStyle = pal.goldSoft;
      ctx.lineWidth = 0.9;
      for (let i = 0; i < 12; i += 1) {
        const a = (i * 30 + 15) * DEG;
        const r0 = 12;
        const r1 = i % 2 === 0 ? 20 : 16;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a) * r0, y - Math.sin(a) * r0);
        ctx.lineTo(x + Math.cos(a) * r1, y - Math.sin(a) * r1);
        ctx.stroke();
      }
      const core = ctx.createRadialGradient(x - 2, y - 2, 1, x, y, 9);
      core.addColorStop(0, "#fff8dc");
      core.addColorStop(1, "#f4c14f");
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(x, y, 8.5, 0, TWO_PI); ctx.fill();
    }

    _drawMoonDisk(ctx, x, y, r, phaseAngle) {
      const pal = this._palette();
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = pal.moonLit;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TWO_PI); ctx.fill();
      const a = wrapDeg(phaseAngle) * DEG;
      ctx.fillStyle = pal.moonDark;
      ctx.beginPath();
      if (Math.cos(a) >= 0) {
        ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, true);
        ctx.ellipse(0, 0, Math.abs(Math.cos(a)) * r, r, 0, Math.PI / 2, -Math.PI / 2, true);
      } else {
        ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
        ctx.ellipse(0, 0, Math.abs(Math.cos(a)) * r, r, 0, Math.PI / 2, -Math.PI / 2, false);
      }
      ctx.fill();
      ctx.strokeStyle = pal.goldSoft;
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TWO_PI); ctx.stroke();
      ctx.restore();
    }

    _label(ctx, text, x, y, opts = {}) {
      const pal = this._palette();
      ctx.font = `${opts.size || 11}px ${SERIF}`;
      ctx.textAlign = opts.align || "left";
      ctx.textBaseline = "middle";
      // Halo for legibility against stars
      ctx.strokeStyle = this._resolveTheme() === "light" ? "rgba(250, 244, 228, 0.8)" : "rgba(5, 6, 13, 0.8)";
      ctx.lineWidth = 3;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = opts.color || pal.ink;
      ctx.fillText(text, x, y);
    }

    /* ----------------------------- solar system ----------------------------- */

    _drawSolarMode(ctx, w, h) {
      const pal = this._palette();
      const date = this._date();
      const earth = planetHeliocentric("Earth", date);

      const visible = PLANET_ORDER
        .map((n) => planetHeliocentric(n, date))
        .filter((p) => p && (p.dwarf ? this._layers.dwarf_planets !== false : this._layers.planets !== false));

      let maxAu = 30.1;
      for (const p of visible) maxAu = Math.max(maxAu, p.r);
      const maxOrbit = this._orbitRadiusUnits(maxAu);
      const zInner = maxOrbit + 14;
      const zOuter = zInner + 26;
      const fit = (Math.min(w, h) / 2 - 8) / (zOuter + 4);
      const k = fit * this._vp.zoom;
      const cx = w / 2 + this._vp.x;
      const cy = h / 2 + this._vp.y;

      // Highlighted sign = the sign of the selected planet (if any)
      let highlightIdx = -1;
      if (this._selectedData && this._selectedData.signIndex != null) {
        highlightIdx = this._selectedData.signIndex;
      }
      this._drawZodiacBand(ctx, cx, cy, zInner * k, zOuter * k, highlightIdx);

      // Orbits (hairline) + trailing motion arcs
      for (const p of visible) {
        const rPx = this._orbitRadiusUnits(p.r) * k;
        ctx.strokeStyle = pal.orbit;
        ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.arc(cx, cy, rPx, 0, TWO_PI); ctx.stroke();
        ctx.strokeStyle = pal.trail;
        ctx.lineWidth = 1.4;
        this._strokeArcLon(ctx, cx, cy, rPx, p.lon, p.lon - 24);
      }

      // Sun
      this._drawSun(ctx, cx, cy);
      this._pickables.push({
        id: "sun", kind: "sun", sx: cx, sy: cy, hit: 22, label: "Sun",
      });

      // Flare/CME direction cone (if active and Earth-directed)
      const sw = this._solarData;
      if (sw && sw.flare_direction && sw.flare_direction.longitude != null) {
        const flareHelioLon = sw.flare_direction.longitude;
        const earthLon = earth.lon;
        const sunToEarthLon = wrapDeg(earthLon + 180);
        const flareLon = wrapDeg(sunToEarthLon - flareHelioLon);
        const flareRad = flareLon * DEG;

        const coneHalfAngle = 25 * DEG;
        const coneInnerR = 25;
        const coneOuterR = this._orbitRadiusUnits(2.5) * k;

        ctx.save();
        const isEarthDir = sw.earth_directed;
        const coneAlpha = isEarthDir ? 0.25 : 0.12;
        const coneColor = isEarthDir ? "rgba(255, 100, 50," : "rgba(255, 180, 80,";

        const coneGrad = ctx.createRadialGradient(cx, cy, coneInnerR, cx, cy, coneOuterR);
        coneGrad.addColorStop(0, `${coneColor}${coneAlpha * 1.5})`);
        coneGrad.addColorStop(0.5, `${coneColor}${coneAlpha})`);
        coneGrad.addColorStop(1, `${coneColor}0)`);
        ctx.fillStyle = coneGrad;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, coneOuterR, -flareRad - coneHalfAngle, -flareRad + coneHalfAngle);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = isEarthDir ? "rgba(255, 80, 40, 0.6)" : "rgba(255, 160, 60, 0.4)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(
          cx + Math.cos(-flareRad - coneHalfAngle) * coneOuterR,
          cy + Math.sin(-flareRad - coneHalfAngle) * coneOuterR
        );
        ctx.moveTo(cx, cy);
        ctx.lineTo(
          cx + Math.cos(-flareRad + coneHalfAngle) * coneOuterR,
          cy + Math.sin(-flareRad + coneHalfAngle) * coneOuterR
        );
        ctx.stroke();
        ctx.setLineDash([]);

        if (sw.cme_watch || isEarthDir) {
          const labelR = coneOuterR * 0.4;
          const labelX = cx + Math.cos(-flareRad) * labelR;
          const labelY = cy + Math.sin(-flareRad) * labelR;
          ctx.font = `bold 10px ${SANS}`;
          ctx.fillStyle = isEarthDir ? "rgba(255, 100, 50, 0.9)" : "rgba(255, 180, 80, 0.8)";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const labelText = sw.cme_watch ? "CME" : "FLARE";
          ctx.fillText(labelText, labelX, labelY);
        }

        ctx.restore();

        this._flareConeData = {
          lon: flareLon,
          halfAngle: coneHalfAngle * RAD,
          earthDirected: isEarthDir,
        };
      } else {
        this._flareConeData = null;
      }

      // NEOs from backend at true positions
      if (this._mapData && Array.isArray(this._mapData.small_bodies)) {
        for (const b of this._mapData.small_bodies) {
          if (b.type === "asteroid" && this._layers.asteroids === false) continue;
          if (b.type === "comet" && this._layers.comets === false) continue;
          if (b.position_available === false || b.x_au == null || b.y_au == null) continue;
          const au = Math.hypot(b.x_au, b.y_au);
          const lon = wrapDeg(Math.atan2(b.y_au, b.x_au) * RAD);
          const pos = this._polar(cx, cy, k, lon, this._orbitRadiusUnits(au));
          const isComet = b.type === "comet";
          ctx.fillStyle = isComet ? pal.comet : pal.asteroid;
          if (isComet) {
            // Tail points anti-sunward (real physics, schematic length)
            const ax = pos.x - cx;
            const ay = pos.y - cy;
            const len = Math.hypot(ax, ay) || 1;
            ctx.strokeStyle = pal.comet;
            ctx.globalAlpha = 0.55;
            ctx.lineWidth = 1;
            for (let t = -1; t <= 1; t += 1) {
              ctx.beginPath();
              ctx.moveTo(pos.x, pos.y);
              ctx.lineTo(
                pos.x + (ax / len) * 13 + (-ay / len) * t * 2.6,
                pos.y + (ay / len) * 13 + (ax / len) * t * 2.6,
              );
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
            ctx.beginPath(); ctx.arc(pos.x, pos.y, 2.6, 0, TWO_PI); ctx.fill();
          } else {
            ctx.beginPath();
            ctx.moveTo(pos.x, pos.y - 3.2);
            ctx.lineTo(pos.x + 3, pos.y + 2.4);
            ctx.lineTo(pos.x - 3, pos.y + 2.4);
            ctx.closePath();
            ctx.fill();
          }
          this._pickables.push({
            id: `neo:${b.id || b.name}`, kind: "neo", sx: pos.x, sy: pos.y, hit: 16,
            label: b.name || "Object", body: b,
          });
        }
      }

      // Planets
      for (const p of visible) {
        const rUnits = this._orbitRadiusUnits(p.r);
        const pos = this._polar(cx, cy, k, p.lon, rUnits);
        const geo = bodySign(p, earth);
        const retro = p.name !== "Earth" && isRetrograde(p.name, date);
        const dotR = p.size * Math.min(1.5, Math.max(0.95, 0.85 + this._vp.zoom * 0.12));

        // Disc with simple limb shading, lit from the sun side
        const lightA = Math.atan2(cy - pos.y, cx - pos.x);
        const grad = ctx.createRadialGradient(
          pos.x + Math.cos(lightA) * dotR * 0.45,
          pos.y + Math.sin(lightA) * dotR * 0.45,
          dotR * 0.15,
          pos.x, pos.y, dotR * 1.15,
        );
        const baseColor = this._resolveTheme() === "light" ? p.lightColor : p.color;
        grad.addColorStop(0, "#ffffff");
        grad.addColorStop(0.32, baseColor);
        grad.addColorStop(1, this._resolveTheme() === "light" ? baseColor : "rgba(8,10,18,0.9)");
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, dotR, 0, TWO_PI); ctx.fill();
        if (this._resolveTheme() === "light") {
          ctx.strokeStyle = "rgba(42, 35, 24, 0.55)";
          ctx.lineWidth = 0.7;
          ctx.stroke();
        }
        if (p.name === "Saturn") {
          ctx.strokeStyle = this._resolveTheme() === "light" ? "rgba(122,100,45,0.8)" : "rgba(236,217,168,0.75)";
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.ellipse(pos.x, pos.y, dotR * 2, dotR * 0.62, -0.42, 0, TWO_PI);
          ctx.stroke();
        }

        // Highlight if planet is in the flare/CME cone
        if (this._flareConeData) {
          const planetLon = p.lon;
          const coneLon = this._flareConeData.lon;
          const halfAngle = this._flareConeData.halfAngle;
          let angleDiff = Math.abs(wrapDeg(planetLon - coneLon));
          if (angleDiff > 180) angleDiff = 360 - angleDiff;
          if (angleDiff <= halfAngle) {
            const animPhase = (Date.now() % 1500) / 1500;
            const pulseR = dotR * (1.6 + 0.3 * Math.sin(animPhase * TWO_PI));
            ctx.strokeStyle = this._flareConeData.earthDirected
              ? `rgba(255, 80, 40, ${0.6 + 0.3 * Math.sin(animPhase * TWO_PI)})`
              : `rgba(255, 160, 60, ${0.4 + 0.2 * Math.sin(animPhase * TWO_PI)})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, pulseR, 0, TWO_PI);
            ctx.stroke();
          }
        }

        const label = `${p.name}  ${geo.sign.glyph}${TS}${retro ? " \u211E" : ""}`;
        // Flip the label to the left side when it would clip the right edge
        ctx.font = `11.5px ${SERIF}`;
        const labelW = ctx.measureText(label).width;
        if (pos.x + dotR + 8 + labelW > w - 4) {
          this._label(ctx, label, pos.x - dotR - 6, pos.y, { size: 11.5, align: "right" });
        } else {
          this._label(ctx, label, pos.x + dotR + 6, pos.y, { size: 11.5 });
        }

        this._pickables.push({
          id: `planet:${p.name}`, kind: "planet",
          sx: pos.x, sy: pos.y, hit: Math.max(14, dotR + 8),
          label: p.name, planet: p, sign: geo.sign, geoLon: geo.lon, retro,
          ofSun: geo.ofSun,
        });

        // Earth's Moon at its true ecliptic longitude (offset exaggerated)
        if (p.name === "Earth" && this._layers.moons !== false && this._vp.zoom >= 1.15) {
          const ms = moonState(date);
          const mOff = Math.min(22, 9 + this._vp.zoom * 3);
          const mPos = {
            x: pos.x + Math.cos(ms.lon * DEG) * mOff,
            y: pos.y - Math.sin(ms.lon * DEG) * mOff,
          };
          this._drawMoonDisk(ctx, mPos.x, mPos.y, 3.4, ms.phaseAngle);
          this._pickables.push({
            id: "moon:Moon", kind: "earthmoon",
            sx: mPos.x, sy: mPos.y, hit: 12, label: "Moon", moon: ms,
          });
        }

        // Schematic moon-system diagram around the selected planet
        if (this._layers.moons !== false
          && this._selectedId === `planet:${p.name}`
          && MOON_FACTS[p.name] && p.name !== "Earth") {
          this._drawMoonDiagram(ctx, pos.x, pos.y, dotR, p.name);
        }
      }
    }

    /** Evenly-spaced diagram of a planet's major moons (labeled as schematic). */
    _drawMoonDiagram(ctx, px, py, dotR, planetName) {
      const pal = this._palette();
      const moons = MOON_FACTS[planetName] || [];
      moons.forEach((m, i) => {
        const rr = dotR + 12 + i * 11;
        ctx.strokeStyle = pal.ring;
        ctx.lineWidth = 0.6;
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.arc(px, py, rr, 0, TWO_PI); ctx.stroke();
        ctx.setLineDash([]);
        const a = (i * 137.5 + 40) * DEG; // golden-angle spread: clearly a diagram
        const mx = px + Math.cos(a) * rr;
        const my = py - Math.sin(a) * rr;
        ctx.fillStyle = pal.moonLit;
        ctx.beginPath(); ctx.arc(mx, my, 2.3, 0, TWO_PI); ctx.fill();
        this._label(ctx, m.name, mx + 5, my, { size: 9, color: pal.muted });
        this._pickables.push({
          id: `pmoon:${planetName}:${m.name}`, kind: "planetmoon",
          sx: mx, sy: my, hit: 11, label: m.name,
          moonFact: m, parent: planetName,
        });
      });
    }

    /* ------------------------------- earth mode ------------------------------ */

    _drawEarthMode(ctx, w, h) {
      const pal = this._palette();
      const date = this._date();
      const ms = moonState(date);

      const R_EARTH = 26;
      const RINGS = [
        { r: 58, name: "LEO", note: "\u2272 2,000 km" },
        { r: 88, name: "MEO", note: "~20,000 km" },
        { r: 118, name: "GEO", note: "35,786 km" },
      ];
      const R_MOON = 158;
      const zInner = 178;
      const zOuter = zInner + 26;
      const fit = (Math.min(w, h) / 2 - 8) / (zOuter + 4);
      const k = fit * this._vp.zoom;
      const cx = w / 2 + this._vp.x;
      const cy = h / 2 + this._vp.y;
      const moonSign = signFromLon(ms.lon);
      this._drawZodiacBand(ctx, cx, cy, zInner * k, zOuter * k, moonSign.index);

      // Orbit shells
      RINGS.forEach((ring, i) => {
        const rPx = ring.r * k;
        ctx.strokeStyle = pal.ring;
        ctx.lineWidth = 0.9;
        ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.arc(cx, cy, rPx, 0, TWO_PI); ctx.stroke();
        ctx.setLineDash([]);
        const la = (222 + i * 12) * DEG;
        this._label(ctx, `${ring.name} \u00B7 ${ring.note}`,
          cx + Math.cos(la) * (rPx + 4), cy - Math.sin(la) * (rPx + 4),
          { size: 9.5, color: pal.muted });
      });

      // Moon orbit ring (solid hairline, gold)
      ctx.strokeStyle = pal.goldSoft;
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(cx, cy, R_MOON * k, 0, TWO_PI); ctx.stroke();

      // Earth
      const eR = R_EARTH * k;
      const eg = ctx.createRadialGradient(cx - eR * 0.35, cy - eR * 0.35, eR * 0.15, cx, cy, eR);
      eg.addColorStop(0, "#9cc8f5");
      eg.addColorStop(0.5, "#3f74c4");
      eg.addColorStop(1, "#12233f");
      ctx.fillStyle = eg;
      ctx.beginPath(); ctx.arc(cx, cy, eR, 0, TWO_PI); ctx.fill();
      // Atlas graticule
      ctx.strokeStyle = "rgba(230, 240, 255, 0.28)";
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.ellipse(cx, cy, eR, eR * 0.38, 0, 0, TWO_PI); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(cx, cy, eR * 0.38, eR, 0, 0, TWO_PI); ctx.stroke();
      ctx.strokeStyle = pal.goldSoft;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, eR, 0, TWO_PI); ctx.stroke();
      this._label(ctx, "Earth", cx, cy - eR - 10, { align: "center", size: 11.5 });
      this._pickables.push({
        id: "earth", kind: "earthcenter", sx: cx, sy: cy, hit: Math.max(22, eR),
        label: "Earth", moon: ms,
      });

      // Moon at true ecliptic longitude with rendered phase
      const mPos = this._polar(cx, cy, k, ms.lon, R_MOON);
      const mR = Math.max(7, Math.min(13, 8 * this._vp.zoom));
      this._drawMoonDisk(ctx, mPos.x, mPos.y, mR, ms.phaseAngle);
      this._label(ctx,
        `Moon  ${moonSign.glyph}${TS} \u00B7 ${Math.round(ms.illumination * 100)}%`,
        mPos.x + mR + 6, mPos.y, { size: 11 });
      this._pickables.push({
        id: "moon:Moon", kind: "earthmoon", sx: mPos.x, sy: mPos.y,
        hit: Math.max(14, mR + 6), label: "Moon", moon: ms,
      });

      // Live satellites — only passes flagged ongoing, placed by real azimuth
      if (this._layers.spacecraft !== false && this._mapData
        && Array.isArray(this._mapData.overhead_passes)) {
        const live = this._mapData.overhead_passes.filter((p) => p.ongoing);
        live.forEach((p) => {
          const az = Number(p.azimuth_deg);
          const hasAz = Number.isFinite(az);
          // North-up compass: az 0° = top, clockwise
          const a = hasAz ? (90 - az) : 90;
          const isStation = /ISS|station/i.test(String(p.craft_name || ""));
          const ring = isStation ? RINGS[0] : RINGS[1];
          const pos = this._polar(cx, cy, k, a, ring.r);
          ctx.fillStyle = pal.live;
          ctx.beginPath();
          ctx.moveTo(pos.x, pos.y - 5);
          ctx.lineTo(pos.x + 5, pos.y);
          ctx.lineTo(pos.x, pos.y + 5);
          ctx.lineTo(pos.x - 5, pos.y);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = pal.live;
          ctx.globalAlpha = 0.4;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(pos.x, pos.y, 9, 0, TWO_PI); ctx.stroke();
          ctx.globalAlpha = 1;
          this._label(ctx, `${p.craft_name || p.craft_id} \u00B7 overhead`,
            pos.x + 9, pos.y, { size: 10, color: pal.live });
          this._pickables.push({
            id: `pass:${p.craft_id}:${p.pass_start}`, kind: "pass",
            sx: pos.x, sy: pos.y, hit: 16, label: p.craft_name || String(p.craft_id),
            pass: p,
          });
        });
      }

      // Compass cue: north marker on the outer band
      this._label(ctx, "N", cx, cy - (zOuter * k) - 10, { align: "center", size: 10, color: pal.muted });
    }

    /* -------------------------------- sun mode ------------------------------- */

    _drawSunMode(ctx, w, h) {
      const pal = this._palette();
      const cx = w / 2 + this._vp.x;
      const cy = h / 2 + this._vp.y;
      const baseR = Math.min(w, h) * 0.28;
      const sunR = baseR * this._vp.zoom;
      const sw = this._solarData;

      // Sun glow layers
      for (let i = 4; i >= 1; i--) {
        const r = sunR * (1 + i * 0.25);
        const g = ctx.createRadialGradient(cx, cy, sunR * 0.3, cx, cy, r);
        g.addColorStop(0, `rgba(255,200,50,${0.12 / i})`);
        g.addColorStop(0.6, `rgba(255,140,20,${0.06 / i})`);
        g.addColorStop(1, "rgba(255,100,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, TWO_PI); ctx.fill();
      }

      // Corona rays
      ctx.save();
      ctx.translate(cx, cy);
      const rayCount = 24;
      for (let i = 0; i < rayCount; i++) {
        const angle = (i / rayCount) * TWO_PI;
        const len = sunR * (1.3 + Math.sin(i * 2.7) * 0.2);
        ctx.strokeStyle = `rgba(255,200,80,${0.15 + Math.sin(i * 1.3) * 0.05})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * sunR * 0.95, Math.sin(angle) * sunR * 0.95);
        ctx.lineTo(Math.cos(angle) * len, Math.sin(angle) * len);
        ctx.stroke();
      }
      ctx.restore();

      // Sun disc with limb darkening
      const sg = ctx.createRadialGradient(cx - sunR * 0.15, cy - sunR * 0.15, sunR * 0.1, cx, cy, sunR);
      sg.addColorStop(0, "#fff8e0");
      sg.addColorStop(0.3, "#ffd54f");
      sg.addColorStop(0.65, "#ffb300");
      sg.addColorStop(0.85, "#e65100");
      sg.addColorStop(1, "#bf360c");
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(cx, cy, sunR, 0, TWO_PI); ctx.fill();

      // Rotation grid overlay (equator and central meridian)
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, sunR, 0, TWO_PI);
      ctx.clip();

      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - sunR, cy);
      ctx.lineTo(cx + sunR, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - sunR);
      ctx.lineTo(cx, cy + sunR);
      ctx.stroke();

      for (let latDeg = -60; latDeg <= 60; latDeg += 30) {
        if (latDeg === 0) continue;
        const latRad = latDeg * DEG;
        const yOff = sunR * Math.sin(latRad);
        const xExtent = sunR * Math.cos(latRad);
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.beginPath();
        ctx.ellipse(cx, cy + yOff, xExtent, xExtent * 0.15, 0, 0, TWO_PI);
        ctx.stroke();
      }

      ctx.restore();

      // Plot sunspot regions using orthographic projection
      const regions = (sw && Array.isArray(sw.regions)) ? sw.regions : [];
      const flares = (sw && Array.isArray(sw.flares)) ? sw.flares : [];
      const flareRegions = new Set(flares.filter(f => f.source_region).map(f => f.source_region));
      const animPhase = (Date.now() % 2000) / 2000;

      for (const region of regions) {
        const lat = region.latitude;
        const lon = region.longitude;
        if (lat == null || lon == null) continue;

        const latRad = lat * DEG;
        const lonRad = lon * DEG;
        const cosFront = Math.cos(latRad) * Math.cos(lonRad);
        if (cosFront < 0) continue;

        const px = cx + sunR * Math.cos(latRad) * Math.sin(lonRad);
        const py = cy - sunR * Math.sin(latRad);

        const area = region.area || 50;
        const spotR = Math.max(4, Math.min(18, Math.sqrt(area / 50) * 6)) * this._vp.zoom;

        const isComplex = region.is_complex || false;
        const hasFlare = flareRegions.has(region.region);
        let spotColor = "rgba(80, 40, 20, 0.85)";
        if (isComplex) {
          spotColor = "rgba(180, 50, 30, 0.9)";
        }

        ctx.save();
        ctx.globalAlpha = 0.3 + 0.5 * cosFront;
        const spotGrad = ctx.createRadialGradient(px - spotR * 0.2, py - spotR * 0.2, 0, px, py, spotR);
        spotGrad.addColorStop(0, "rgba(30, 15, 10, 0.95)");
        spotGrad.addColorStop(0.5, spotColor);
        spotGrad.addColorStop(1, "rgba(60, 30, 20, 0.3)");
        ctx.fillStyle = spotGrad;
        ctx.beginPath();
        ctx.arc(px, py, spotR, 0, TWO_PI);
        ctx.fill();

        if (hasFlare) {
          const pulseR = spotR * (1.5 + 0.5 * Math.sin(animPhase * TWO_PI));
          ctx.strokeStyle = `rgba(255, 100, 50, ${0.6 + 0.4 * Math.sin(animPhase * TWO_PI)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, pulseR, 0, TWO_PI);
          ctx.stroke();
        }

        ctx.restore();

        if (sunR > 80) {
          ctx.font = `bold ${Math.max(9, 11 * this._vp.zoom)}px ${SANS}`;
          ctx.fillStyle = "rgba(255,255,255,0.8)";
          ctx.textAlign = "center";
          ctx.fillText(String(region.region), px, py - spotR - 4);
        }

        this._pickables.push({
          id: `region:${region.region}`,
          kind: "region",
          sx: px,
          sy: py,
          hit: Math.max(spotR + 4, 12),
          label: `Region ${region.region}`,
          region: region,
        });
      }

      // Draw flare markers for flares with known location but no matching region
      for (const flare of flares) {
        if (flare.source_region) continue;
        const lat = flare.latitude;
        const lon = flare.longitude;
        if (lat == null || lon == null) continue;

        const latRad = lat * DEG;
        const lonRad = lon * DEG;
        const cosFront = Math.cos(latRad) * Math.cos(lonRad);
        if (cosFront < 0) continue;

        const px = cx + sunR * Math.cos(latRad) * Math.sin(lonRad);
        const py = cy - sunR * Math.sin(latRad);

        const pulseR = 8 * this._vp.zoom * (1 + 0.3 * Math.sin(animPhase * TWO_PI));
        ctx.strokeStyle = `rgba(255, 80, 30, ${0.7 + 0.3 * Math.sin(animPhase * TWO_PI)})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(px, py, pulseR, 0, TWO_PI);
        ctx.stroke();

        ctx.fillStyle = "rgba(255, 200, 100, 0.9)";
        ctx.beginPath();
        ctx.arc(px, py, 3 * this._vp.zoom, 0, TWO_PI);
        ctx.fill();

        if (flare.class && sunR > 80) {
          ctx.font = `bold ${Math.max(9, 10 * this._vp.zoom)}px ${SANS}`;
          ctx.fillStyle = "rgba(255, 200, 100, 0.95)";
          ctx.textAlign = "center";
          ctx.fillText(flare.class, px, py - 12 * this._vp.zoom);
        }
      }

      // Sun label
      this._label(ctx, "Sun", cx, cy - sunR - 18, { align: "center", size: 14, color: pal.text, bold: true });

      // Make sun pickable for detail card
      this._pickables.push({
        id: "sun:Sun", kind: "sun", sx: cx, sy: cy, hit: sunR * 0.3, label: "Sun",
      });

      // Legend (bottom right)
      if (regions.length > 0 && sunR > 60) {
        const legX = w - 160;
        let legY = h - 100;
        ctx.font = `bold 11px ${SANS}`;
        ctx.fillStyle = pal.text;
        ctx.textAlign = "left";
        ctx.fillText("SUNSPOT LEGEND", legX, legY);
        legY += 18;

        ctx.fillStyle = "rgba(80, 40, 20, 0.85)";
        ctx.beginPath(); ctx.arc(legX + 6, legY, 5, 0, TWO_PI); ctx.fill();
        ctx.fillStyle = pal.muted;
        ctx.font = `10px ${SANS}`;
        ctx.fillText("Active Region", legX + 18, legY + 3);
        legY += 16;

        ctx.fillStyle = "rgba(180, 50, 30, 0.9)";
        ctx.beginPath(); ctx.arc(legX + 6, legY, 5, 0, TWO_PI); ctx.fill();
        ctx.fillStyle = pal.muted;
        ctx.fillText("Complex (Beta-Gamma-Delta)", legX + 18, legY + 3);
        legY += 16;

        ctx.strokeStyle = "rgba(255, 100, 50, 0.8)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(legX + 6, legY, 6, 0, TWO_PI); ctx.stroke();
        ctx.fillStyle = pal.muted;
        ctx.fillText("Active Flare", legX + 18, legY + 3);
      }

      // Solar weather stats panel
      const panelX = 24;
      let panelY = 80;
      const lineH = 24;

      ctx.fillStyle = pal.text;
      ctx.font = `bold 16px ${SANS}`;
      ctx.textAlign = "left";
      ctx.fillText("SOLAR WEATHER", panelX, panelY);
      panelY += 10;

      ctx.font = `13px ${SANS}`;
      ctx.fillStyle = pal.muted;

      if (!sw) {
        panelY += lineH;
        ctx.fillText("Loading solar data…", panelX, panelY);
      } else {
        const rows = [];
        if (sw.active_regions_count != null && sw.active_regions_count > 0) {
          rows.push(["Active Regions", String(sw.active_regions_count)]);
        }
        if (sw.k_index != null) {
          const kp = sw.k_index;
          let level = "Quiet";
          if (kp >= 5) level = "Storm";
          else if (kp >= 4) level = "Active";
          else if (kp >= 3) level = "Unsettled";
          rows.push(["Kp Index", `${kp} (${level})`]);
        }
        if (sw.xray_class) rows.push(["X-ray Class", String(sw.xray_class)]);
        if (sw.sunspot_number != null) rows.push(["Sunspot Number", String(Math.round(sw.sunspot_number))]);
        if (sw.solar_wind_speed != null) rows.push(["Solar Wind", `${Math.round(sw.solar_wind_speed)} km/s`]);
        if (sw.solar_wind_density != null) rows.push(["Wind Density", `${sw.solar_wind_density.toFixed(1)} p/cm³`]);
        if (sw.bt != null) rows.push(["Bt (IMF)", `${sw.bt.toFixed(1)} nT`]);
        if (sw.bz != null) rows.push(["Bz (IMF)", `${sw.bz.toFixed(1)} nT`]);
        if (sw.flare_active) rows.push(["Solar Flare", "Active"]);
        if (sw.earth_directed) rows.push(["Earth Directed", "Yes"]);
        if (sw.cme_watch) rows.push(["CME Watch", "Yes"]);
        if (sw.aurora_activity) rows.push(["Aurora Activity", String(sw.aurora_activity)]);

        if (rows.length === 0) {
          panelY += lineH;
          ctx.fillText("No solar data available", panelX, panelY);
        } else {
          rows.forEach(([label, value]) => {
            panelY += lineH;
            ctx.fillStyle = pal.muted;
            ctx.fillText(label, panelX, panelY);
            ctx.fillStyle = pal.text;
            ctx.fillText(value, panelX + 130, panelY);
          });
        }
      }

      // Data source note
      panelY += lineH + 10;
      ctx.fillStyle = pal.muted;
      ctx.font = `11px ${SANS}`;
      ctx.fillText("Source: NOAA SWPC", panelX, panelY);
    }

    /* ------------------------------- selection ------------------------------- */

    _drawSelection(ctx) {
      if (!this._selectedId) return;
      const p = this._pickables.find((it) => it.id === this._selectedId);
      if (!p) return;
      const pal = this._palette();
      const r = Math.max(12, p.hit + 3);
      ctx.strokeStyle = pal.gold;
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, TWO_PI); ctx.stroke();
      ctx.strokeStyle = pal.goldSoft;
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, r + 5, 0, TWO_PI); ctx.stroke();
      // Four cardinal notches, atlas-instrument style
      for (let i = 0; i < 4; i += 1) {
        const a = i * Math.PI / 2 + Math.PI / 4;
        ctx.strokeStyle = pal.gold;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p.sx + Math.cos(a) * (r + 5), p.sy + Math.sin(a) * (r + 5));
        ctx.lineTo(p.sx + Math.cos(a) * (r + 10), p.sy + Math.sin(a) * (r + 10));
        ctx.stroke();
      }
    }

    _select(pickable, opts = {}) {
      if (!pickable) {
        this._selectedId = null;
        this._selectedData = null;
        const card = this._el('[data-sm="card"]');
        if (card) { card.hidden = true; card.innerHTML = ""; card.className = "sm-card"; }
        if (!opts.silent) this._announce("Selection cleared.");
        this._dirty = true;
        return;
      }
      this._selectedId = pickable.id;
      this._selectedData = this._describe(pickable);
      this._renderCard();
      if (!opts.silent && this._selectedData) {
        this._announce(`${this._selectedData.title}. ${this._selectedData.srSummary || ""}`);
      }
      this._dirty = true;
    }

    _refreshCard() {
      if (!this._selectedId) return;
      const p = this._pickables.find((it) => it.id === this._selectedId);
      if (p) {
        this._selectedData = this._describe(p);
        this._renderCard();
      }
    }

    /** Build a structured description (title/kind/rows/note) for a pickable. */
    _describe(p) {
      const date = this._date();
      const rows = [];
      let title = p.label || "Object";
      let glyph = "";
      let kind = "";
      let note = "";
      let signIndex = null;
      let srSummary = "";
      let theme = "";

      if (p.kind === "western_zodiac") {
        const z = ZODIAC[p.index];
        title = z.name;
        glyph = z.glyph + TS;
        kind = "Western Zodiac \u00B7 30\u00B0 sector";
        theme = "western";
        signIndex = p.index;
        rows.push(["Element", z.element]);
        rows.push(["Quality", z.quality]);
        rows.push(["Season dates", ZODIAC_DATE_RANGES[p.index] || "\u2014"]);
        rows.push(["Chinese counterpart", CHINESE_ZODIAC[p.index].name]);
        note = "Tap planets and the Moon to see which sign they occupy today.";
        srSummary = `${z.name}, a ${z.element.toLowerCase()} sign.`;
      } else if (p.kind === "chinese_zodiac") {
        const z = CHINESE_ZODIAC[p.index];
        title = z.name;
        kind = "Chinese Zodiac \u00B7 Shichen sector";
        theme = "chinese";
        signIndex = p.index;
        rows.push(["Element", z.element]);
        rows.push(["Yin / Yang", z.yin ? "Yin" : "Yang"]);
        rows.push(["Pinyin", z.pinyin]);
        rows.push(["Western counterpart", ZODIAC[p.index].name]);
        note = "English names only on the chart ring; year-of-animal forecasts use the lunar calendar.";
        srSummary = `${z.name}, ${z.yin ? "yin" : "yang"} ${z.element.toLowerCase()}.`;
      } else if (p.kind === "sun") {
        const earth = planetHeliocentric("Earth", date);
        title = "Sun";
        glyph = PLANET_GLYPHS.Sun + TS;
        kind = "Star \u00B7 Solar Weather";
        rows.push(["Distance from Earth", `${fmtAU(earth.r)} (${fmtMkm(earth.r)})`]);
        const sw = this._solarData;
        if (sw) {
          if (sw.active_regions_count != null && sw.active_regions_count > 0) {
            rows.push(["Active regions", String(sw.active_regions_count)]);
          }
          if (sw.sunspot_number != null) rows.push(["Sunspot number", String(Math.round(sw.sunspot_number))]);
          if (sw.k_index != null) {
            let level = "Quiet";
            if (sw.k_index >= 5) level = "Storm";
            else if (sw.k_index >= 4) level = "Active";
            else if (sw.k_index >= 3) level = "Unsettled";
            rows.push(["Planetary Kp", `${sw.k_index} (${level})${sw.g_scale ? ` G${sw.g_scale}` : ""}`]);
          }
          if (sw.xray_class) rows.push(["X-ray class", String(sw.xray_class)]);
          if (sw.f107_flux != null) rows.push(["F10.7 flux", `${Math.round(sw.f107_flux)} sfu`]);
          if (sw.solar_wind_speed != null) rows.push(["Solar wind", `${Math.round(sw.solar_wind_speed)} km/s`]);
          if (sw.solar_wind_density != null) rows.push(["Wind density", `${sw.solar_wind_density.toFixed(1)} p/cm\u00B3`]);
          if (sw.bz != null) rows.push(["IMF Bz", `${sw.bz.toFixed(1)} nT`]);
          if (sw.bt != null) rows.push(["IMF Bt", `${sw.bt.toFixed(1)} nT`]);
          if (sw.flare_active) rows.push(["Solar flare", "Active"]);
          if (sw.earth_directed) rows.push(["Earth directed", "Yes"]);
          if (sw.cme_watch) rows.push(["CME watch", "Yes"]);
          if (sw.geomagnetic_storm_active) rows.push(["Geomagnetic storm", "Active"]);
          if (sw.aurora_activity) rows.push(["Aurora activity", String(sw.aurora_activity)]);
          note = String(sw.attribution || "NOAA Space Weather Prediction Center");
          const statusParts = [];
          if (sw.flare_active) statusParts.push(`${sw.xray_class || ""} flare active`);
          if (sw.geomagnetic_storm_active) statusParts.push(`G${sw.g_scale} storm`);
          if (sw.active_regions_count > 0) statusParts.push(`${sw.active_regions_count} active regions`);
          srSummary = statusParts.length > 0 ? statusParts.join(", ") + "." : "Solar activity quiet.";
        } else {
          note = "No live space-weather data. Enable Solar display in Settings \u2192 Space.";
          srSummary = "Solar weather data loading.";
        }
      } else if (p.kind === "region") {
        const reg = p.region;
        title = `Region ${reg.region}`;
        glyph = "\u2600" + TS;
        kind = "Sunspot Region";
        if (reg.location) rows.push(["Location", reg.location]);
        if (reg.latitude != null && reg.longitude != null) {
          rows.push(["Heliographic", `${reg.latitude.toFixed(0)}\u00B0 lat, ${reg.longitude.toFixed(0)}\u00B0 lon`]);
        }
        if (reg.carrington_longitude != null) rows.push(["Carrington lon", `${Math.round(reg.carrington_longitude)}\u00B0`]);
        if (reg.spot_class) rows.push(["Spot class", reg.spot_class]);
        if (reg.mag_class) rows.push(["Mag class", reg.mag_class]);
        if (reg.area != null) rows.push(["Area", `${reg.area} \u03BCH`]);
        if (reg.number_spots != null) rows.push(["Spot count", String(reg.number_spots)]);
        if (reg.c_flare_probability != null) rows.push(["C-flare prob", `${reg.c_flare_probability}%`]);
        if (reg.m_flare_probability != null) rows.push(["M-flare prob", `${reg.m_flare_probability}%`]);
        if (reg.x_flare_probability != null) rows.push(["X-flare prob", `${reg.x_flare_probability}%`]);
        if (reg.is_complex) {
          rows.push(["Complex", "Beta-Gamma-Delta"]);
        }
        const earthDir = reg.longitude != null && Math.abs(reg.longitude) <= 45;
        if (earthDir) rows.push(["Earth facing", "Yes"]);
        note = "NOAA SWPC Active Region Summary";
        srSummary = `Sunspot region ${reg.region}${reg.mag_class ? `, ${reg.mag_class}` : ""}${reg.is_complex ? ", complex" : ""}.`;
      } else if (p.kind === "planet") {
        const pl = p.planet;
        title = pl.name;
        glyph = (PLANET_GLYPHS[pl.name] || "") + TS;
        kind = pl.dwarf ? "Dwarf planet \u00B7 heliocentric" : "Planet \u00B7 heliocentric";
        signIndex = p.sign.index;
        rows.push([p.ofSun ? "Sun is in" : "In sign", signLabel(p.sign)]);
        rows.push(["Sign traits", `${p.sign.element}, ${p.sign.quality}`]);
        rows.push(["Chinese sector", chineseSignLabel(chineseSignFromIndex(p.sign.index))]);
        if (pl.name !== "Earth") {
          rows.push(["Motion", p.retro ? "Retrograde \u211E" : "Direct"]);
        }
        rows.push(["Distance from Sun", `${fmtAU(pl.r)} (${fmtMkm(pl.r)})`]);
        if (pl.name !== "Earth") {
          const earth = planetHeliocentric("Earth", date);
          const dE = Math.hypot(pl.x - earth.x, pl.y - earth.y, pl.z - earth.z);
          rows.push(["Distance from Earth", `${fmtAU(dE)} (${fmtMkm(dE)})`]);
        }
        rows.push(["Orbital period", fmtPeriod(pl.period)]);
        const moons = MOON_FACTS[pl.name];
        if (moons && moons.length) {
          rows.push(["Major moons", moons.map((m) => m.name).join(", ")]);
          if (pl.name !== "Earth" && this._layers.moons !== false) {
            note = "Moon rings are a diagram, not live positions. Tap a moon for facts.";
          }
        }
        srSummary = `${pl.name} in ${p.sign.name}${p.retro ? ", retrograde" : ""}.`;
      } else if (p.kind === "earthmoon") {
        const ms = p.moon || moonState(date);
        const s = signFromLon(ms.lon);
        title = "Moon";
        glyph = PLANET_GLYPHS.Moon + TS;
        kind = "Natural satellite of Earth";
        signIndex = s.index;
        rows.push(["Phase", ms.phaseName]);
        rows.push(["Illumination", `${Math.round(ms.illumination * 100)}%`]);
        rows.push(["Distance", fmtKm(ms.distKm)]);
        rows.push(["In sign", signLabel(s)]);
        rows.push(["Sign traits", `${s.element}, ${s.quality}`]);
        rows.push(["Chinese sector", chineseSignLabel(chineseSignFromIndex(s.index))]);
        rows.push(["Orbital period", "27.3 d (sidereal)"]);
        srSummary = `${ms.phaseName}, ${Math.round(ms.illumination * 100)} percent illuminated, in ${s.name}.`;
      } else if (p.kind === "earthcenter") {
        const earth = planetHeliocentric("Earth", date);
        const sunSign = signFromLon(wrapDeg(earth.lon + 180));
        title = "Earth";
        glyph = PLANET_GLYPHS.Earth + TS;
        kind = "Home \u00B7 geocentric chart origin";
        signIndex = sunSign.index;
        rows.push(["Distance from Sun", `${fmtAU(earth.r)} (${fmtMkm(earth.r)})`]);
        rows.push(["Sun is in", signLabel(sunSign)]);
        rows.push(["Sign traits", `${sunSign.element}, ${sunSign.quality}`]);
        rows.push(["Chinese sector", chineseSignLabel(chineseSignFromIndex(sunSign.index))]);
        const ms = p.moon || moonState(date);
        rows.push(["Moon tonight", `${ms.phaseName} \u00B7 ${Math.round(ms.illumination * 100)}%`]);
      } else if (p.kind === "neo") {
        const b = p.body || {};
        title = b.name || "Near-Earth object";
        glyph = b.type === "comet" ? "\u2604" + TS : "\u26B6" + TS;
        kind = b.type === "comet" ? "Comet \u00B7 JPL CNEOS" : "Asteroid \u00B7 JPL CNEOS";
        if (b.lunar_distance != null) {
          const ld = Number(b.lunar_distance);
          rows.push(["Miss distance", `${fmtLD(ld)} (${fmtKm(ld * LD_KM)})`]);
        }
        if (b.close_approach_date) rows.push(["Close approach", String(b.close_approach_date)]);
        if (b.velocity_kms != null) rows.push(["Velocity", `${Number(b.velocity_kms).toFixed(1)} km/s`]);
        if (b.diameter_km != null) rows.push(["Diameter", `~${(Number(b.diameter_km) * 1000).toLocaleString()} m`]);
        if (b.distance_au != null) rows.push(["Distance from Sun", fmtAU(b.distance_au)]);
        if (b.source) rows.push(["Source", String(b.source).toUpperCase()]);
        if (b.position_available === false) {
          note = "No live position for this object \u2014 it is listed from close-approach data only.";
        }
        srSummary = b.lunar_distance != null ? `Miss distance ${fmtLD(b.lunar_distance)}.` : "";
      } else if (p.kind === "pass") {
        const pass = p.pass || {};
        title = pass.craft_name || String(pass.craft_id || "Spacecraft");
        glyph = "\u2726" + TS; // four-pointed star; satellite glyph renders unreliably
        kind = pass.ongoing ? "Spacecraft \u00B7 overhead now" : "Spacecraft pass";
        rows.push(["Status", pass.ongoing ? "In pass \u2014 overhead" : "Upcoming"]);
        rows.push(["Pass start", fmtLocal(pass.pass_start)]);
        rows.push(["Peak", fmtLocal(pass.peak_time)]);
        if (pass.max_elevation_deg != null) rows.push(["Max elevation", `${pass.max_elevation_deg}\u00B0`]);
        if (pass.azimuth_deg != null) rows.push(["Azimuth", `${Math.round(pass.azimuth_deg)}\u00B0`]);
        note = "Ring placement is schematic; azimuth is real.";
        srSummary = pass.ongoing ? "Overhead now." : `Pass starts ${fmtLocal(pass.pass_start)}.`;
      } else if (p.kind === "deepcraft") {
        const b = p.body || {};
        title = b.name || "Spacecraft";
        glyph = "\u2726" + TS;
        kind = "Deep-space spacecraft \u00B7 heliocentric";
        if (b.distance_au != null) rows.push(["Distance from Sun", `${fmtAU(b.distance_au)} (${fmtMkm(b.distance_au)})`]);
        if (b.velocity_kms != null) rows.push(["Velocity", `${Number(b.velocity_kms).toFixed(1)} km/s`]);
        note = "Position from JPL Horizons via the backend.";
      } else if (p.kind === "planetmoon") {
        const m = p.moonFact || {};
        title = m.name || "Moon";
        glyph = PLANET_GLYPHS.Moon + TS;
        kind = `Moon of ${p.parent}`;
        rows.push(["Orbital distance", fmtKm(m.distKm)]);
        rows.push(["Orbital period", fmtPeriod(m.periodD)]);
        note = "Shown on a diagram ring \u2014 not a live position.";
      }

      return { title, glyph, kind, rows, note, signIndex, srSummary, theme };
    }

    _renderCard() {
      const card = this._el('[data-sm="card"]');
      if (!card) return;
      const d = this._selectedData;
      if (!d) { card.hidden = true; card.innerHTML = ""; return; }
      card.hidden = false;
      card.className = "sm-card" + (d.theme ? ` sm-card--${d.theme}` : "");
      card.innerHTML = `
        <button type="button" class="sm-close" aria-label="Close details">\u00D7</button>
        <div class="sm-card-head">
          ${d.glyph ? `<span class="sm-card-glyph" aria-hidden="true">${esc(d.glyph)}</span>` : ""}
          <h4>${esc(d.title)}</h4>
        </div>
        <div class="sm-kind">${esc(d.kind)}</div>
        ${d.rows.map(([kLabel, v]) => `
          <div class="sm-kv"><span>${esc(kLabel)}</span><strong>${esc(v)}</strong></div>`).join("")}
        ${d.note ? `<div class="sm-note">${esc(d.note)}</div>` : ""}`;
      const closeBtn = card.querySelector(".sm-close");
      if (closeBtn) closeBtn.addEventListener("click", () => this._select(null));
    }

    /* -------------------------- drawer & solar chip -------------------------- */

    _renderChip() {
      const chip = this._el('[data-sm="solar-chip"]');
      if (!chip) return;
      // Zodiac chip appears wherever the zodiac ring is shown (not Sun mode).
      const show = this._mode !== "sun";
      chip.hidden = !show;
      if (!show) return;
      const date = this._date();
      const w = westernSunSignByDate(date);
      const c = chineseYearByDate(date);
      chip.classList.add("sm-chip-zodiac");
      chip.innerHTML = `
        <span class="sm-chip-z-title">Zodiac</span>
        <span class="sm-chip-z-west"><span class="sm-chip-z-glyph" aria-hidden="true">${w.glyph}${TS}</span>${esc(w.name)}</span>
        <span class="sm-chip-z-dot" aria-hidden="true">\u00B7</span>
        <span class="sm-chip-z-cn">${esc(c.element)} ${esc(c.animal)}</span>`;
      chip.setAttribute(
        "aria-label",
        `Zodiac. Western sun sign ${w.name}. Chinese year of the ${c.polarity} ${c.element} ${c.animal}. Show sign details.`,
      );
    }

    _renderDrawer() {
      const drawer = this._el("#sm-drawer");
      const toggle = this._el('[data-sm="drawer-toggle"]');
      if (!drawer || !toggle) return;

      if (this._mode === "earth") this._renderEarthDrawer(drawer, toggle);
      else if (this._mode === "sun") this._renderSunDrawer(drawer, toggle);
      else this._renderSolarDrawer(drawer, toggle);
      this._syncDrawerVisibility();
    }

    _renderSunDrawer(drawer, toggle) {
      const sw = this._solarData;
      toggle.textContent = "\u2600 Solar Data";
      toggle.hidden = false;

      if (!sw) {
        drawer.innerHTML = `
          <div class="sm-drawer-title">\u2600 SOLAR WEATHER</div>
          <div class="sm-drawer-empty">Loading solar weather data\u2026</div>
        `;
        return;
      }

      const rows = [];
      if (sw.active_regions_count != null && sw.active_regions_count > 0) {
        rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">Active Regions</span><span class="sm-drawer-value">${sw.active_regions_count}</span></div>`);
      }
      if (sw.k_index != null) {
        let level = "Quiet";
        if (sw.k_index >= 5) level = "Storm";
        else if (sw.k_index >= 4) level = "Active";
        else if (sw.k_index >= 3) level = "Unsettled";
        rows.push(`<div class="sm-drawer-row" data-sm-row="kp"><span class="sm-drawer-label">Kp Index</span><span class="sm-drawer-value">${sw.k_index} (${level})</span></div>`);
      }
      if (sw.xray_class) rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">X-ray Class</span><span class="sm-drawer-value">${esc(sw.xray_class)}</span></div>`);
      if (sw.sunspot_number != null) rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">Sunspot Number</span><span class="sm-drawer-value">${Math.round(sw.sunspot_number)}</span></div>`);
      if (sw.solar_wind_speed != null) rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">Solar Wind</span><span class="sm-drawer-value">${Math.round(sw.solar_wind_speed)} km/s</span></div>`);
      if (sw.solar_wind_density != null) rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">Wind Density</span><span class="sm-drawer-value">${Number(sw.solar_wind_density).toFixed(1)} p/cm\u00B3</span></div>`);
      if (sw.bt != null) rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">Bt (IMF)</span><span class="sm-drawer-value">${Number(sw.bt).toFixed(1)} nT</span></div>`);
      if (sw.bz != null) rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">Bz (IMF)</span><span class="sm-drawer-value">${Number(sw.bz).toFixed(1)} nT</span></div>`);
      if (sw.flare_active) rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">Solar Flare</span><span class="sm-drawer-value">Active</span></div>`);
      if (sw.earth_directed) rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">Earth Directed</span><span class="sm-drawer-value">Yes</span></div>`);
      if (sw.cme_watch) rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">CME Watch</span><span class="sm-drawer-value">Yes</span></div>`);
      if (sw.aurora_activity) rows.push(`<div class="sm-drawer-row"><span class="sm-drawer-label">Aurora Activity</span><span class="sm-drawer-value">${esc(sw.aurora_activity)}</span></div>`);

      let regionsHtml = "";
      const regions = Array.isArray(sw.regions) ? sw.regions : [];
      if (regions.length > 0) {
        const regionRows = regions.slice(0, 8).map((reg) => {
          const loc = reg.location || `${reg.latitude || "?"}/${reg.longitude || "?"}`;
          const magBadge = reg.is_complex
            ? `<span style="color:#e65100;font-weight:600;">${esc(reg.mag_class || "Complex")}</span>`
            : esc(reg.mag_class || "");
          return `<div class="sm-drawer-row sm-drawer-row-region" data-region="${esc(String(reg.region))}">
            <span class="sm-drawer-label">${esc(String(reg.region))}</span>
            <span class="sm-drawer-value">${esc(loc)} ${magBadge}</span>
          </div>`;
        }).join("");
        regionsHtml = `
          <div class="sm-drawer-title" style="margin-top:12px;">\u2609 ACTIVE REGIONS</div>
          ${regionRows}
        `;
      }

      let flaresHtml = "";
      const flares = Array.isArray(sw.flares) ? sw.flares : [];
      if (flares.length > 0) {
        const flareRows = flares.slice(0, 5).map((f) => {
          const cls = f.class || f.xray_class || "?";
          const region = f.source_region ? `AR${f.source_region}` : "";
          const earthDir = f.earth_directed ? " \u2192\u{1F30D}" : "";
          return `<div class="sm-drawer-row">
            <span class="sm-drawer-label">${esc(cls)}</span>
            <span class="sm-drawer-value">${esc(region)}${earthDir}</span>
          </div>`;
        }).join("");
        flaresHtml = `
          <div class="sm-drawer-title" style="margin-top:12px;">\u26A1 RECENT FLARES</div>
          ${flareRows}
        `;
      }

      const html = rows.length > 0 ? rows.join("") : `<div class="sm-drawer-empty">No solar data available</div>`;
      drawer.innerHTML = `
        <div class="sm-drawer-title">\u2600 SOLAR WEATHER</div>
        ${html}
        ${regionsHtml}
        ${flaresHtml}
        <div class="sm-drawer-note">Source: NOAA SWPC</div>
      `;
    }

    _renderSolarDrawer(drawer, toggle) {
      const data = this._mapData || {};
      const all = Array.isArray(data.small_bodies) ? data.small_bodies : [];
      const primary = data.primary_close_approach || null;
      const filtered = all.filter((b) => {
        if (b.type === "asteroid" && this._layers.asteroids === false) return false;
        if (b.type === "comet" && this._layers.comets === false) return false;
        return true;
      });
      const sorted = filtered.slice().sort(
        (a, b) => (Number(a.lunar_distance) || 9e9) - (Number(b.lunar_distance) || 9e9),
      ).slice(0, 12);

      toggle.innerHTML = `<span class="sm-chip-glyph" aria-hidden="true">\u2604${TS}</span>NEOs${sorted.length ? ` \u00B7 ${sorted.length}` : ""}`;
      toggle.setAttribute("aria-label", `Toggle near-Earth object list, ${sorted.length} tracked`);

      if (!sorted.length && !primary) {
        const layersOff = this._layers.asteroids === false && this._layers.comets === false;
        drawer.innerHTML = `
          <h3>Near-Earth Objects</h3>
          <div class="sm-empty">
            <span class="sm-empty-glyph" aria-hidden="true">\u2604${TS}</span>
            ${layersOff
    ? "Asteroid and comet layers are hidden. Re-enable them in the Layers menu."
    : "No close-approach data from the backend right now. Enable NEO monitoring in Settings \u2192 Space, then refresh."}
          </div>`;
        return;
      }

      const primaryName = primary ? String(primary.name || "") : "";
      const rowsHtml = sorted.map((b, i) => {
        const pinned = primaryName && String(b.name) === primaryName;
        const sub = [
          b.lunar_distance != null ? fmtLD(b.lunar_distance) : null,
          b.close_approach_date ? String(b.close_approach_date).slice(0, 11) : null,
          b.velocity_kms != null ? `${Number(b.velocity_kms).toFixed(1)} km/s` : null,
        ].filter(Boolean).join(" \u00B7 ");
        return `
          <button type="button" class="sm-row ${pinned ? "sm-pinned" : ""}" data-neo-idx="${i}">
            <strong>${esc(b.name || "Object")}${pinned ? '<span class="sm-tag">closest</span>' : ""}${b.type === "comet" ? '<span class="sm-tag">comet</span>' : ""}</strong>
            <span class="sm-sub">${esc(sub || "no approach data")}</span>
          </button>`;
      }).join("");

      drawer.innerHTML = `
        <h3>Near-Earth Objects <span class="sm-count">\u00B7 ${sorted.length}</span></h3>
        <div class="sm-drawer-scroll">${rowsHtml}</div>
        <div class="sm-foot">JPL CNEOS \u00B7 Scout / Sentry / close-approach data</div>`;

      drawer.querySelectorAll("[data-neo-idx]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const b = sorted[Number(btn.getAttribute("data-neo-idx"))];
          if (!b) return;
          const onMap = this._pickables.find((it) => it.id === `neo:${b.id || b.name}`);
          this._select(onMap || {
            id: `neo:${b.id || b.name}`, kind: "neo", label: b.name, body: b, hit: 0, sx: -1e4, sy: -1e4,
          });
        });
      });
    }

    _renderEarthDrawer(drawer, toggle) {
      const data = this._mapData || {};
      const passes = Array.isArray(data.overhead_passes) ? data.overhead_passes : [];
      const meta = data.pass_meta || {};
      const deep = (Array.isArray(data.bodies) ? data.bodies : [])
        .filter((b) => b.type === "spacecraft");
      const showCraft = this._layers.spacecraft !== false;

      const count = showCraft ? passes.length : 0;
      toggle.innerHTML = `<span class="sm-chip-glyph" aria-hidden="true">\u2726${TS}</span>Passes${count ? ` \u00B7 ${count}` : ""}`;
      toggle.setAttribute("aria-label", `Toggle satellite pass list, ${count} passes`);

      let passHtml;
      if (!showCraft) {
        passHtml = `<div class="sm-empty">
          <span class="sm-empty-glyph" aria-hidden="true">\u2726${TS}</span>
          The spacecraft layer is hidden. Re-enable it in the Layers menu.</div>`;
      } else if (meta.error === "no_home") {
        passHtml = `<div class="sm-empty">
          <span class="sm-empty-glyph" aria-hidden="true">\u2726${TS}</span>
          Set your home latitude and longitude in Home Assistant
          (Settings \u2192 Home, or edit <strong>zone.home</strong> on the map).
          Passes are computed for your home location.</div>`;
      } else if (meta.error === "horizons_empty") {
        passHtml = `<div class="sm-empty">
          <span class="sm-empty-glyph" aria-hidden="true">\u2726${TS}</span>
          Could not load pass data from JPL Horizons. Check your network connection,
          verify craft IDs in Settings \u2192 Space \u2192 Spacecraft Tracking
          (default ISS is <code>-125544</code>), then use Actions \u2192 Refresh.</div>`;
      } else if (!passes.length) {
        const hrs = meta.lookahead_hours || 48;
        passHtml = `<div class="sm-empty">
          <span class="sm-empty-glyph" aria-hidden="true">\u2726${TS}</span>
          No satellite passes above ${meta.min_elevation_deg != null ? meta.min_elevation_deg : 10}\u00B0
          in the next ${hrs} hours for your location.
          Try Actions \u2192 Refresh, or add craft IDs under Settings \u2192 Space.</div>`;
      } else {
        const ordered = passes.slice().sort((a, b) => (b.ongoing ? 1 : 0) - (a.ongoing ? 1 : 0));
        passHtml = ordered.slice(0, 10).map((p, i) => `
          <button type="button" class="sm-row" data-pass-idx="${i}">
            <strong>${esc(p.craft_name || p.craft_id)}${p.ongoing ? '<span class="sm-tag sm-live">live</span>' : ""}</strong>
            <span class="sm-sub">${esc(`${fmtLocal(p.pass_start)} \u00B7 peak ${fmtLocal(p.peak_time)} \u00B7 max ${p.max_elevation_deg != null ? p.max_elevation_deg : "\u2014"}\u00B0`)}</span>
          </button>`).join("");
      }

      let deepHtml = "";
      if (showCraft && deep.length) {
        deepHtml = `
          <h3>Deep Space</h3>
          ${deep.slice(0, 6).map((b, i) => `
            <button type="button" class="sm-row" data-deep-idx="${i}">
              <strong>${esc(b.name || b.id)}</strong>
              <span class="sm-sub">${esc(b.distance_au != null ? `${fmtAU(b.distance_au, 2)} from Sun` : "distance unavailable")}</span>
            </button>`).join("")}`;
      }

      drawer.innerHTML = `
        <h3>Satellite Passes${count ? ` <span class="sm-count">\u00B7 ${count}</span>` : ""}</h3>
        <div class="sm-drawer-scroll">
          ${passHtml}
          ${deepHtml}
        </div>
        <div class="sm-foot">JPL Horizons \u00B7 passes computed for your home location</div>`;

      const ordered = (passes.slice().sort((a, b) => (b.ongoing ? 1 : 0) - (a.ongoing ? 1 : 0)));
      drawer.querySelectorAll("[data-pass-idx]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const p = ordered[Number(btn.getAttribute("data-pass-idx"))];
          if (!p) return;
          const onMap = this._pickables.find((it) => it.id === `pass:${p.craft_id}:${p.pass_start}`);
          this._select(onMap || {
            id: `pass:${p.craft_id}:${p.pass_start}`, kind: "pass", label: p.craft_name,
            pass: p, hit: 0, sx: -1e4, sy: -1e4,
          });
        });
      });
      drawer.querySelectorAll("[data-deep-idx]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const b = deep[Number(btn.getAttribute("data-deep-idx"))];
          if (!b) return;
          this._select({
            id: `deep:${b.id || b.name}`, kind: "deepcraft", label: b.name,
            body: b, hit: 0, sx: -1e4, sy: -1e4,
          });
        });
      });
    }

    /* ---------------------------- pointer / keys ----------------------------- */

    _pickAt(clientX, clientY) {
      if (!this._canvas) return null;
      const rect = this._canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const zPick = this._pickZodiacAt(sx, sy);
      if (zPick) return zPick;
      let best = null;
      let bestD = Infinity;
      for (const p of this._pickables) {
        const d = Math.hypot(sx - p.sx, sy - p.sy);
        const hit = Math.max(p.hit, 22); // 44px touch target
        if (d <= hit && d < bestD) { best = p; bestD = d; }
      }
      return best;
    }

    _handlePointerDown(event) {
      this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this._canvas.setPointerCapture) {
        try { this._canvas.setPointerCapture(event.pointerId); } catch (_) { /* ok */ }
      }
      if (this._pointers.size === 1) {
        this._dragMoved = false;
        this._lastX = event.clientX;
        this._lastY = event.clientY;
      } else if (this._pointers.size === 2) {
        const pts = [...this._pointers.values()];
        this._pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      }
    }

    _handlePointerMove(event) {
      if (!this._pointers.has(event.pointerId)) return;
      this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this._pointers.size === 2) {
        const pts = [...this._pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this._pinchDist > 0) {
          const rect = this._canvas.getBoundingClientRect();
          this._vp.zoomBy(
            dist / this._pinchDist,
            (pts[0].x + pts[1].x) / 2 - rect.left,
            (pts[0].y + pts[1].y) / 2 - rect.top,
            rect.width, rect.height,
          );
          this._dragMoved = true;
          this._dirty = true;
        }
        this._pinchDist = dist;
        return;
      }
      if (this._pointers.size !== 1) return;
      const dx = event.clientX - this._lastX;
      const dy = event.clientY - this._lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._dragMoved = true;
      this._lastX = event.clientX;
      this._lastY = event.clientY;
      if (this._dragMoved) {
        this._vp.pan(dx, dy);
        this._dirty = true;
      }
    }

    _handlePointerUp(event) {
      const wasPinch = this._pointers.size >= 2;
      this._pointers.delete(event.pointerId);
      if (this._canvas.releasePointerCapture) {
        try { this._canvas.releasePointerCapture(event.pointerId); } catch (_) { /* ok */ }
      }
      if (this._pointers.size < 2) this._pinchDist = 0;
      if (this._pointers.size === 0 && !wasPinch && !this._dragMoved
        && event.type === "pointerup") {
        const hit = this._pickAt(event.clientX, event.clientY);
        if (hit) this._select(hit);
        else this._select(null, { silent: true });
      }
      if (this._pointers.size === 0) this._dragMoved = false;
    }

    _handleWheel(event) {
      event.preventDefault();
      const rect = this._canvas.getBoundingClientRect();
      this._vp.zoomBy(
        event.deltaY > 0 ? 0.88 : 1.14,
        event.clientX - rect.left, event.clientY - rect.top,
        rect.width, rect.height,
      );
      this._dirty = true;
    }

    _cycleSelection(dir) {
      if (!this._pickables.length) return;
      let idx = this._pickables.findIndex((p) => p.id === this._selectedId);
      idx = idx === -1
        ? (dir > 0 ? 0 : this._pickables.length - 1)
        : (idx + dir + this._pickables.length) % this._pickables.length;
      const next = this._pickables[idx];
      // Centre it so keyboard users always see what they selected
      const rect = this._canvas.getBoundingClientRect();
      this._vp.pan(rect.width / 2 - next.sx, rect.height / 2 - next.sy);
      this._dirty = true;
      // Re-select after the pan is applied on next draw; the id is stable.
      this._select(next);
    }

    _handleKeyDown(event) {
      const step = event.shiftKey ? 120 : 40;
      switch (event.key) {
        case "ArrowLeft": this._vp.pan(step, 0); break;
        case "ArrowRight": this._vp.pan(-step, 0); break;
        case "ArrowUp": this._vp.pan(0, step); break;
        case "ArrowDown": this._vp.pan(0, -step); break;
        case "+": case "=": this._zoomCenter(1.2); break;
        case "-": case "_": this._zoomCenter(1 / 1.2); break;
        case "0": this._vp.reset(); break;
        case "n": case "N": case "]": this._cycleSelection(1); break;
        case "p": case "P": case "[": this._cycleSelection(-1); break;
        case "Escape": this._select(null); break;
        default: return;
      }
      event.preventDefault();
      this._dirty = true;
    }
  }

  global.SpaceMap = SpaceMap;
})(typeof window !== "undefined" ? window : globalThis);

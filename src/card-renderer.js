function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function compactText(value = "", max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = (Number(seed) || 1) >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

function wrapText(text, maxChars, maxLines) {
  const chars = Array.from(compactText(text, maxChars * maxLines));
  const lines = [];
  let line = "";
  for (const char of chars) {
    line += char;
    const wide = /[\p{Script=Han}！？。，、；：“”‘’（）]/u.test(char);
    const length = Array.from(line).reduce((sum, item) => sum + (/[\p{Script=Han}]/u.test(item) ? 1 : 0.56), 0);
    if (wide && length >= maxChars) {
      lines.push(line);
      line = "";
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

function artSvg(card, width, height) {
  const random = seededRandom(card.artSeed || hashText(`${card.id}:${card.quote}:${card.note}`));
  if (card.art === "ripple") {
    const centers = [
      [width * (0.24 + random() * 0.1), height * (0.2 + random() * 0.08)],
      [width * (0.56 + random() * 0.12), height * (0.42 + random() * 0.12)],
      [width * (0.2 + random() * 0.08), height * (0.68 + random() * 0.08)],
    ];
    return centers
      .flatMap(([cx, cy], groupIndex) =>
        Array.from({ length: groupIndex === 1 ? 4 : 3 }, (_, index) => {
          const radius = 34 + index * (30 + random() * 16) + random() * 10;
          const opacity = 0.035 + random() * 0.055;
          return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="none" stroke="#665648" stroke-width="1.2" opacity="${opacity.toFixed(3)}"/>`;
        }),
      )
      .join("");
  }
  if (card.art === "stardust") {
    const dots = Array.from({ length: 72 }, () => {
      const cx = 28 + random() * (width - 56);
      const cy = 38 + random() * (height - 90);
      const radius = 0.35 + random() * 0.95;
      const opacity = 0.16 + random() * 0.38;
      return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(2)}" fill="#584e40" opacity="${opacity.toFixed(3)}"/>`;
    }).join("");
    const crosses = Array.from({ length: 7 }, () => {
      const cx = 48 + random() * (width - 96);
      const cy = 58 + random() * (height - 116);
      const opacity = 0.18 + random() * 0.22;
      return `<path d="M ${(cx - 3).toFixed(1)} ${cy.toFixed(1)} L ${(cx + 3).toFixed(1)} ${cy.toFixed(1)} M ${cx.toFixed(1)} ${(cy - 3).toFixed(1)} L ${cx.toFixed(1)} ${(cy + 3).toFixed(1)}" stroke="#584e40" stroke-width="0.7" opacity="${opacity.toFixed(3)}"/>`;
    }).join("");
    return `${dots}${crosses}`;
  }
  return Array.from({ length: 16 }, () => {
    const x = 34 + random() * (width - 68);
    const drift = (random() - 0.5) * 34;
    const opacity = 0.045 + random() * 0.1;
    return `<path d="M ${x.toFixed(1)} 18 C ${(x + drift).toFixed(1)} ${(height * 0.32).toFixed(1)} ${(x - drift).toFixed(1)} ${(height * 0.68).toFixed(1)} ${x.toFixed(1)} ${(height - 18).toFixed(1)}" fill="none" stroke="#4c453d" stroke-width="0.9" opacity="${opacity.toFixed(3)}"/>`;
  }).join("");
}

export function renderCardSvg(card = {}) {
  const quoteLength = String(card.quote || "").length;
  const noteLength = String(card.note || "").length;
  const totalLength = quoteLength + noteLength;
  const height = totalLength < 110 ? 680 : totalLength > 310 ? 980 : 820;
  const width = 720;
  const quoteLines = wrapText(card.quote || "A passage worth carrying forward.", 14, totalLength > 310 ? 7 : 5);
  const noteLines = wrapText(card.note || "A small card from the margin.", 28, totalLength > 310 ? 5 : 4);
  const titleLines = wrapText(card.title || card.bookTitle || "Reading Card", 11, 2);
  const subtitle = compactText(card.subtitle || [card.bookTitle, card.chunkTitle].filter(Boolean).join(" · "), 52);
  const quoteY = totalLength < 110 ? 348 : 406;
  const noteY = height - 190;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fbf6ee"/>
      <stop offset="0.6" stop-color="#eeeae2"/>
      <stop offset="1" stop-color="#e5e4dc"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="28" stdDeviation="34" flood-color="#46362a" flood-opacity="0.14"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="transparent"/>
  <rect x="24" y="24" width="${width - 48}" height="${height - 48}" rx="48" fill="url(#paper)" filter="url(#shadow)"/>
  <rect x="24.5" y="24.5" width="${width - 49}" height="${height - 49}" rx="47.5" fill="none" stroke="#ffffff" stroke-opacity="0.8"/>
  <g>${artSvg(card, width, height)}</g>
  <g font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif" fill="#28241f">
    <text x="76" y="92" font-size="20" font-weight="800" letter-spacing="2" fill="#9d968d">${escapeXml(compactText(card.sourceLabel || "READING CARD", 26).toUpperCase())}</text>
    <text x="76" y="146" font-size="22" font-weight="800" fill="#777168">${escapeXml(card.kicker || "收获了一枚回声书签")}</text>
    ${titleLines.map((line, index) => `<text x="76" y="${212 + index * 58}" font-size="50" font-weight="800">${escapeXml(line)}</text>`).join("")}
    <text x="76" y="${titleLines.length > 1 ? 334 : 282}" font-size="22" fill="#868078">${escapeXml(subtitle)}</text>
  </g>
  <g font-family="Georgia, 'Times New Roman', 'Songti SC', serif" fill="#34302b">
    ${quoteLines.map((line, index) => `<text x="76" y="${quoteY + index * 54}" font-size="38">${escapeXml(line)}</text>`).join("")}
  </g>
  <line x1="76" x2="644" y1="${noteY - 38}" y2="${noteY - 38}" stroke="#28241f" stroke-opacity="0.12"/>
  <g font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif" fill="#4b463f">
    <text x="76" y="${noteY}" font-size="18" font-weight="800" fill="#817b72">MARGIN</text>
    ${noteLines.map((line, index) => `<text x="76" y="${noteY + 42 + index * 30}" font-size="22">${escapeXml(line)}</text>`).join("")}
    <text x="76" y="${height - 74}" font-size="20" fill="#817b72">${escapeXml(card.footer || "A small card from the margin.")}</text>
  </g>
</svg>`;
}

export function renderCardImageContent(card) {
  return {
    type: "image",
    mimeType: "image/svg+xml",
    data: Buffer.from(renderCardSvg(card), "utf8").toString("base64"),
  };
}

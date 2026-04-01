import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import websiteScraper from 'website-scraper';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || (process.env.NODE_ENV === 'production' ? 8080 : 3001);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'running' });
});

const exportsDir = path.join(__dirname, 'exports');
if (!fs.existsSync(exportsDir)) {
  fs.mkdirSync(exportsDir, { recursive: true });
}

const exports = new Map();
const cleanupTimers = new Map();
const EXPORT_TTL_MS = 15 * 60 * 1000;

function clearCleanupTimer(exportId) {
  const timer = cleanupTimers.get(exportId);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(exportId);
  }
}

function cleanupExport(exportId) {
  clearCleanupTimer(exportId);

  const zipPath = path.join(exportsDir, `${exportId}.zip`);
  if (fs.existsSync(zipPath)) {
    try {
      fs.unlinkSync(zipPath);
    } catch (error) {
      console.error(`Failed to remove export zip for ${exportId}:`, error.message);
    }
  }

  exports.delete(exportId);
}

function scheduleExportCleanup(exportId) {
  clearCleanupTimer(exportId);
  const timer = setTimeout(() => {
    cleanupExport(exportId);
  }, EXPORT_TTL_MS);

  cleanupTimers.set(exportId, timer);
}

const DEFAULT_EXPORT_OPTIONS = {
  platform: 'webflow',
  exportCss: true,
  cssFolderName: 'css',
  exportJs: true,
  jsFolderName: 'js',
  exportImages: false,
  exportAllPages: false,
  removeWatermarks: true,
  htmlExtension: false,
  depth: 3,
  preserveAnimations: true
};

const PLATFORM_WATERMARK_SELECTORS = {
  webflow: ['[class*="webflow"]', 'a[href*="webflow"]'],
  squarespace: ['[class*="squarespace"]', 'a[href*="squarespace"]'],
  framer: ['[class*="framer"]', '[data-framer]', 'a[href*="framer"]']
};

const WATERMARK_SELECTORS = [
  '[class*="framer"]',
  '[data-framer]',
  'div[class*="watermark"]',
  'div[class*="made-with"]',
  'div[class*="powered-by"]',
  'div[class*="footer-badge"]',
  '[class*="fs-badge"]',
  '[class*="webflow"]',
  '[class*="wix"]',
  'a[href*="framer"]',
  'a[href*="webflow"]',
  '.footer',
  'footer'
];

async function scrapeWebsite(url, exportDir, updateProgress, options) {
  updateProgress(10, 'Initializing...');

  const tempDir = path.join(exportDir, 'temp');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const optionsConfig = { ...DEFAULT_EXPORT_OPTIONS, ...(options || {}) };

  const optionsScraper = {
    urls: [url],
    directory: tempDir,
    request: {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    },
    subresources: {
      test: (resource) => {
        const resourceUrl = resource.getUrl();
        if (resourceUrl.startsWith('data:')) return false;
        if (resourceUrl.startsWith('blob:')) return false;
        if (resourceUrl.includes('google-analytics')) return false;
        if (resourceUrl.includes('googletagmanager')) return false;
        if (resourceUrl.includes('facebook.net')) return false;
        if (resourceUrl.includes('hotjar')) return false;
        return true;
      },
      files: {
        globs: ['**/*']
      }
    },
    maxDepth: optionsConfig.exportAllPages ? Math.max(3, optionsConfig.depth || 3) : 1,
    maxConcurrentRequests: 10,
    timeout: 30000
  };

  try {
    updateProgress(20, 'Downloading files...');
    await websiteScraper(optionsScraper);
    
    updateProgress(50, 'Organizing files...');
    
    const { filePlan } = await organizeFiles(tempDir, exportDir, optionsConfig);
    
    updateProgress(70, 'Processing HTML...');
    
    await processHtmlFiles(exportDir, tempDir, filePlan, optionsConfig);
    
    if (optionsConfig.removeWatermarks !== false) {
      updateProgress(80, 'Removing watermarks...');
      await removeWatermarks(exportDir, optionsConfig.platform);
    }
    
    updateProgress(90, 'Adding animation support...');
    
    if (optionsConfig.preserveAnimations !== false) {
      await ensureAnimationsWork(exportDir);
    }
    
    updateProgress(95, 'Generating stats...');
    
    const stats = generateExportStats(exportDir, optionsConfig);
    
    fs.writeFileSync(
      path.join(exportDir, 'export-meta.json'),
      JSON.stringify(stats, null, 2)
    );
    
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

    return { stats };
    
  } catch (error) {
    console.error('Scraper error:', error);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

function normalizePath(value) {
  return value.replace(/\\/g, '/');
}

function ensureFolderName(name, fallback) {
  const sanitized = String(name || '').trim().replace(/[\\/]+/g, '-');
  return sanitized || fallback;
}

function stripQueryAndHash(value) {
  return value.split('#')[0].split('?')[0];
}

function isRemoteUrl(value) {
  return /^(?:https?:|data:|blob:|mailto:|tel:|javascript:|#|\/\/)/i.test(value);
}

function resolveSourceReference(sourceFile, rawUrl, sourceDir) {
  const url = stripQueryAndHash(rawUrl.trim());
  if (!url || isRemoteUrl(url)) return null;

  const candidates = [];
  if (url.startsWith('/')) {
    candidates.push(path.resolve(sourceDir, `.${url}`));
  } else {
    candidates.push(path.resolve(path.dirname(sourceFile), url));
    candidates.push(path.resolve(sourceDir, url));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getHtmlDestination(sourceRel, isPrimaryIndex, htmlExtension) {
  if (isPrimaryIndex) {
    return 'index.html';
  }

  const normalized = normalizePath(sourceRel);
  if (!htmlExtension) {
    return normalized;
  }

  const parsed = path.posix.parse(normalized);
  const lowerName = parsed.base.toLowerCase();
  if (lowerName === 'index.html' || lowerName === 'index.htm') {
    const parent = path.posix.basename(parsed.dir);
    return `${parent || 'index'}.html`;
  }

  return path.posix.join(parsed.dir, `${parsed.name}.html`);
}

function joinFolderPath(folderName, relativePath) {
  const normalized = normalizePath(relativePath);
  const prefix = `${folderName}/`;
  const cleaned = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  return cleaned ? path.posix.join(folderName, cleaned) : folderName;
}

function getDestinationForFile(sourceFile, sourceDir, destDir, options, primaryIndex) {
  const sourceRel = path.relative(sourceDir, sourceFile);
  const normalizedRel = normalizePath(sourceRel);
  const ext = path.extname(sourceFile).toLowerCase();
  const cssFolderName = ensureFolderName(options.cssFolderName, 'css');
  const jsFolderName = ensureFolderName(options.jsFolderName, 'js');

  if (['.html', '.htm'].includes(ext)) {
    if (!options.exportAllPages && sourceFile !== primaryIndex) {
      return null;
    }

    return getHtmlDestination(normalizedRel, sourceFile === primaryIndex, options.htmlExtension);
  }

  if (['.css', '.scss', '.less', '.sass'].includes(ext)) {
    return options.exportCss === false ? null : joinFolderPath(cssFolderName, normalizedRel);
  }

  if (['.js', '.mjs', '.ts', '.jsx', '.tsx'].includes(ext)) {
    return options.exportJs === false ? null : joinFolderPath(jsFolderName, normalizedRel);
  }

  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.apng', '.bmp', '.svg'].includes(ext)) {
    return options.exportImages === false ? null : joinFolderPath('images', normalizedRel);
  }

  if (['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext)) {
    return options.exportImages === false ? null : joinFolderPath('fonts', normalizedRel);
  }

  if (['.mp4', '.webm', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext)) {
    return options.exportImages === false ? null : joinFolderPath('media', normalizedRel);
  }

  return path.posix.join('assets', normalizedRel);
}

async function processHtmlFiles(exportDir, sourceDir, filePlan, options) {
  const plannedEntries = Array.from(filePlan.values());

  for (const entry of plannedEntries) {
    if (!/\.html?$/.test(entry.destinationAbs)) continue;

    let content = fs.readFileSync(entry.destinationAbs, 'utf8');
    content = await injectViewportMeta(content);
    fs.writeFileSync(entry.destinationAbs, content, 'utf8');
  }
}

async function organizeFiles(sourceDir, destDir, options) {
  const dirs = {
    css: path.join(destDir, ensureFolderName(options.cssFolderName, 'css')),
    js: path.join(destDir, ensureFolderName(options.jsFolderName, 'js')),
    images: path.join(destDir, 'images'),
    fonts: path.join(destDir, 'fonts'),
    media: path.join(destDir, 'media'),
    assets: path.join(destDir, 'assets')
  };

  for (const dir of Object.values(dirs)) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const files = getAllFiles(sourceDir);
  const filePlan = new Map();
  let primaryIndex = null;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const filename = path.basename(file);
    if (filename === 'index.html' || filename === 'index.htm') {
      if (!primaryIndex || path.relative(sourceDir, file).split(path.sep).length < path.relative(sourceDir, primaryIndex).split(path.sep).length) {
        primaryIndex = file;
      }
    }
  }

  for (const file of files) {
    if (!fs.existsSync(file)) continue;

    const destinationRel = getDestinationForFile(file, sourceDir, destDir, options, primaryIndex);
    if (!destinationRel) continue;

    const destinationAbs = path.join(destDir, destinationRel.replace(/\//g, path.sep));
    filePlan.set(file, {
      source: file,
      destinationRel,
      destinationAbs
    });
  }

  for (const entry of filePlan.values()) {
    fs.mkdirSync(path.dirname(entry.destinationAbs), { recursive: true });

    const ext = path.extname(entry.source).toLowerCase();
    if (['.html', '.htm', '.css', '.scss', '.less', '.sass'].includes(ext)) {
      const content = fs.readFileSync(entry.source, 'utf8');
      let updated = content;

      if (['.html', '.htm'].includes(ext)) {
        updated = rewriteHtmlContent(content, entry.source, entry.destinationAbs, sourceDir, destDir, filePlan, options);
      } else {
        updated = rewriteCssContent(content, entry.source, entry.destinationAbs, sourceDir, destDir, filePlan);
      }

      fs.writeFileSync(entry.destinationAbs, updated, 'utf8');
      continue;
    }

    fs.copyFileSync(entry.source, entry.destinationAbs);
  }

  return {
    primaryIndex,
    filePlan
  };
}

function getAllFiles(dir, files = []) {
  try {
    if (!fs.existsSync(dir)) return files;
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          getAllFiles(fullPath, files);
        } else if (stat.isFile()) {
          files.push(fullPath);
        }
      } catch {}
    }
  } catch {}
  return files;
}

function rewriteReference(rawUrl, sourceFile, destinationAbs, sourceDir, destDir, filePlan) {
  const cleanUrl = stripQueryAndHash(rawUrl.trim());
  const suffix = rawUrl.slice(cleanUrl.length);

  if (!cleanUrl || isRemoteUrl(cleanUrl)) {
    return rawUrl;
  }

  const sourceReference = resolveSourceReference(sourceFile, cleanUrl, sourceDir);
  if (!sourceReference) {
    return rawUrl;
  }

  const planned = filePlan.get(sourceReference);
  if (!planned) {
    return rawUrl;
  }

  const relativeTarget = path.relative(path.dirname(destinationAbs), planned.destinationAbs).replace(/\\/g, '/');
  return `${relativeTarget}${suffix}`;
}

function rewriteHtmlContent(html, sourceFile, destinationAbs, sourceDir, destDir, filePlan, options) {
  let content = html;

  content = content.replace(/\b(?:src|href|poster)=(["'])([^"']+)\1/gi, (match, quote, rawUrl) => {
    const rewritten = rewriteReference(rawUrl, sourceFile, destinationAbs, sourceDir, destDir, filePlan);
    return rewritten === rawUrl ? match : match.replace(rawUrl, rewritten);
  });

  content = content.replace(/srcset=(["'])([^"']+)\1/gi, (match, quote, value) => {
    const rewritten = value.split(',').map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return trimmed;
      const pieces = trimmed.split(/\s+/);
      const rawUrl = pieces.shift();
      const descriptor = pieces.join(' ');
      const resolved = rewriteReference(rawUrl, sourceFile, destinationAbs, sourceDir, destDir, filePlan);
      return descriptor ? `${resolved} ${descriptor}` : resolved;
    }).join(', ');

    return `${match.split('=')[0]}=${quote}${rewritten}${quote}`;
  });

  if (options.exportCss === false) {
    content = content.replace(/<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi, '');
  }

  if (options.exportJs === false) {
    content = content.replace(/<script\b[^>]*src=["'][^"']+["'][^>]*>\s*<\/script>/gi, '');
  }

  if (options.exportImages === false) {
    content = content.replace(/<img\b[^>]*>/gi, '');
  }

  return content;
}

function rewriteCssContent(css, sourceFile, destinationAbs, sourceDir, destDir, filePlan) {
  let content = css;

  content = content.replace(/url\(['"]?((?!http|https|data:|blob:)[^'"\)]+)['"]?\)/gi, (match, rawUrl) => {
    const rewritten = rewriteReference(rawUrl, sourceFile, destinationAbs, sourceDir, destDir, filePlan);
    return `url("${rewritten}")`;
  });

  content = content.replace(/@import\s+["']((?!http|https|data:|blob:)[^"']+)["']/gi, (match, rawUrl) => {
    const rewritten = rewriteReference(rawUrl, sourceFile, destinationAbs, sourceDir, destDir, filePlan);
    return `@import "${rewritten}"`;
  });

  return content;
}

async function injectViewportMeta(html) {
  if (!html.includes('viewport')) {
    const viewportMeta = '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">';
    if (html.includes('<head>')) {
      html = html.replace('<head>', `<head>\n  ${viewportMeta}`);
    }
  }
  return html;
}

function getHtmlFiles(dir) {
  return getAllFiles(dir).filter((file) => file.endsWith('.html') || file.endsWith('.htm'));
}

function injectBadgeRemovalScript(html) {
  const badgeStyles = `
<style id="webx-badge-removal-styles">
  #__framer-badge-container,
  [data-framer-badge],
  [aria-label="Made in Framer"],
  a[href*="framer.com"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
</style>`;

  const badgeScript = `
<script id="webx-badge-removal-script">
(function() {
  'use strict';

  const badgeSelectors = [
    '#__framer-badge-container',
    '[data-framer-badge]',
    '[aria-label="Made in Framer"]'
  ];

  const badgeTextPattern = /^(?:\s*Made in Framer\s*|\s*Built with Framer\s*)$/i;

  function removeBadges() {
    badgeSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => element.remove());
    });

    document.querySelectorAll('a, div, span').forEach((element) => {
      if (element.textContent && badgeTextPattern.test(element.textContent.trim())) {
        element.remove();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', removeBadges, { once: true });
  } else {
    removeBadges();
  }

  if ('MutationObserver' in window && document.documentElement) {
    new MutationObserver(removeBadges).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }
})();
</script>`;

  if (html.includes('</head>') && !html.includes('webx-badge-removal-styles')) {
    html = html.replace('</head>', `${badgeStyles}\n</head>`);
  }

  if (html.includes('</body>') && !html.includes('webx-badge-removal-script')) {
    html = html.replace('</body>', `${badgeScript}\n</body>`);
  }

  html = html.replace(/<!--\s*✨\s*Built with Framer[^>]*-->/gi, '');
  html = html.replace(/<!--\s*Built with Framer[^>]*-->/gi, '');
  html = html.replace(/<div[^>]*id=["']__framer-badge-container["'][\s\S]*?<\/div>/gi, '');
  html = html.replace(/<a[^>]*aria-label=["']Made in Framer["'][^>]*>[\s\S]*?<\/a>/gi, '');

  return html;
}

async function removeWatermarks(exportDir, platform) {
  const isFramer = platform === 'framer';
  const selectors = [
    ...WATERMARK_SELECTORS,
    ...(PLATFORM_WATERMARK_SELECTORS[platform] || [])
  ];

  const htmlFiles = getHtmlFiles(exportDir);

  for (const file of htmlFiles) {
    let html = fs.readFileSync(file, 'utf8');

    if (!isFramer) {
      for (const selector of selectors) {
        const cleanSelector = selector.replace(/\[|\]|\*/g, '');
        const classMatch = cleanSelector.match(/class\*="([^"]+)"/);
        const attrMatch = cleanSelector.match(/\[([^\]]+)\]/);

        if (classMatch) {
          const className = classMatch[1];
          const pattern = new RegExp(`<[^>]*(?:class=["'][^"']*${className}[^"']*["')])[^>]*>[\\s\\S]*?<\/[^>]+>`, 'gi');
          html = html.replace(pattern, '');

          const selfClosing = new RegExp(`<[^>]*(?:class=["'][^"']*${className}[^"']*["')])[^>]*/?>`, 'gi');
          html = html.replace(selfClosing, '');
        }

        if (attrMatch) {
          const attr = attrMatch[1];
          const pattern = new RegExp(`<[^>]*${attr}[^>]*>[\\s\\S]*?<\/[^>]+>`, 'gi');
          html = html.replace(pattern, '');
        }
      }

      const footerPatterns = [
        /<footer[^>]*>[\s\S]*?<\/footer>/gi,
        /<div[^>]*class=["'][^"']*footer[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
        /<a[^>]*href=["'][^"']*(?:framer\.com|webflow\.io|wix\.com|squarespace\.com|shopify\.com)[^"']*["'][^>]*>[\s\S]*?<\/a>/gi
      ];

      for (const pattern of footerPatterns) {
        html = html.replace(pattern, '');
      }

      html = html.replace(/<script[^>]*framer[^>]*>[\s\S]*?<\/script>/gi, '');
      html = html.replace(/<script[^>]*webflow[^>]*>[\s\S]*?<\/script>/gi, '');
      html = html.replace(/<link[^>]*(?:framer|webflow)[^>]*>/gi, '');
      html = html.replace(/<meta[^>]*content=["'][^"']*(?:framer|webflow)[^"']*["'][^>]*>/gi, '');
      html = html.replace(/<link[^>]*href=["'][^"']*framer[^"']*["'][^>]*>/gi, '');
      html = html.replace(/<style[^>]*data-framer-css-ssr-minified[^>]*>[\s\S]*?<\/style>/gi, (match) => match);

      html = injectBadgeRemovalScript(html);

      const cssRemoval = `
<style>
/* Builder watermarks removed */
[class*="framer"]:not(html):not(body),
[data-framer],
#__framer-badge-container,
[data-framer-badge],
[aria-label="Made in Framer"],
.footer,
[class*="watermark"],
[class*="made-with"],
[class*="powered-by"],
a[href*="framer"]:not([href^="http"]),
a[href*="webflow"]:not([href^="http"]) {
  display: none !important;
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
  height: 0 !important;
  width: 0 !important;
  overflow: hidden !important;
}
</style>`;

      if (html.includes('</head>')) {
        html = html.replace('</head>', cssRemoval + '\n</head>');
      }
    }

    fs.writeFileSync(file, html, 'utf8');
  }
}

async function ensureAnimationsWork(exportDir) {
  const indexPath = path.join(exportDir, 'index.html');
  if (!fs.existsSync(indexPath)) return;

  let html = fs.readFileSync(indexPath, 'utf8');

  const animationPolyfill = `
<script>
(function() {
  'use strict';
  
  if (!window.IntersectionObserver) {
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; this.entries = []; }
      observe(el) { this.entries.push({ target: el, isIntersecting: true }); this.callback(this.entries, this); }
      unobserve() {} disconnect() {}
    };
  }
  
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        entry.target.classList.remove('out-of-view');
      }
    });
  }, { threshold: 0.1 });
  
  document.querySelectorAll('.animate-on-scroll, .scroll-trigger, [data-animate], .fade-in, .slide-up, .reveal').forEach(el => observer.observe(el));
  
  if ('MutationObserver' in window) {
    new MutationObserver(() => {
      document.querySelectorAll('.animate-on-scroll, .scroll-trigger, [data-animate]:not(.observed)').forEach(el => {
        el.classList.add('observed');
        observer.observe(el);
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
  
  if ('IntersectionObserver' in window) {
    const imgObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute('data-src'); }
          if (img.dataset.srcset) { img.srcset = img.dataset.srcset; img.removeAttribute('data-srcset'); }
          imgObserver.unobserve(img);
        }
      });
    });
    document.querySelectorAll('img[loading="lazy"], img[data-src], img[data-srcset]').forEach(img => imgObserver.observe(img));
  }
})();
</script>`;

  if (!html.includes('IntersectionObserver') || !html.includes('animation-polyfill')) {
    if (html.includes('</body>')) {
      html = html.replace('</body>', animationPolyfill + '\n</body>');
    } else {
      html += animationPolyfill;
    }
  }

  const animationCSS = `
<style>
*, *::before, *::after { animation-fill-mode: both; -webkit-animation-fill-mode: both; }
html { scroll-behavior: smooth; -webkit-scroll-behavior: smooth; }
.in-view { opacity: 1 !important; transform: none !important; -webkit-transform: none !important; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
</style>`;

  if (html.includes('</head>')) {
    html = html.replace('</head>', animationCSS + '\n</head>');
  }

  fs.writeFileSync(indexPath, html, 'utf8');
}

function generateExportStats(exportDir, options = DEFAULT_EXPORT_OPTIONS) {
  const stats = {
    totalFiles: 0,
    totalSize: 0,
    folders: {
      [ensureFolderName(options.cssFolderName, 'css')]: { count: 0, size: 0 },
      [ensureFolderName(options.jsFolderName, 'js')]: { count: 0, size: 0 },
      images: { count: 0, size: 0 },
      fonts: { count: 0, size: 0 },
      media: { count: 0, size: 0 },
      assets: { count: 0, size: 0 }
    },
    htmlPages: 0
  };

  const folders = [ensureFolderName(options.cssFolderName, 'css'), ensureFolderName(options.jsFolderName, 'js'), 'images', 'fonts', 'media', 'assets'];
  
  for (const folder of folders) {
    const folderPath = path.join(exportDir, folder);
    if (fs.existsSync(folderPath)) {
      const files = getAllFiles(folderPath);
      for (const file of files) {
        try {
          const stat = fs.statSync(file);
          stats.folders[folder].count++;
          stats.folders[folder].size += stat.size;
          stats.totalFiles++;
          stats.totalSize += stat.size;
        } catch {}
      }
    }
  }

  const htmlFiles = getAllFiles(exportDir).filter(f => 
    (f.endsWith('.html') || f.endsWith('.htm')) && !f.includes('export-meta')
  );
  stats.htmlPages = htmlFiles.length;
  
  for (const file of htmlFiles) {
    try {
      const stat = fs.statSync(file);
      stats.totalFiles++;
      stats.totalSize += stat.size;
    } catch {}
  }

  return stats;
}

async function exportWebsite(url, exportId, updateProgress, options) {
  const exportDir = path.join(exportsDir, exportId);

  if (fs.existsSync(exportDir)) {
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
  fs.mkdirSync(exportDir, { recursive: true });

  let result;

  try {
    result = await scrapeWebsite(url, exportDir, updateProgress, options);
  } catch (error) {
    console.error('Export failed:', error);
    updateProgress(30, 'Fallback method...');
    
    const browser = await puppeteer.launch({
      headless: 'new',
      timeout: 90000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });

    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      const html = await page.content();
      const indexPath = path.join(exportDir, 'index.html');
      fs.writeFileSync(indexPath, html, 'utf8');

      const fallbackOptions = { ...DEFAULT_EXPORT_OPTIONS, ...(options || {}) };
      fs.mkdirSync(path.join(exportDir, ensureFolderName(fallbackOptions.cssFolderName, 'css')), { recursive: true });
      fs.mkdirSync(path.join(exportDir, ensureFolderName(fallbackOptions.jsFolderName, 'js')), { recursive: true });
      fs.mkdirSync(path.join(exportDir, 'images'), { recursive: true });
      fs.mkdirSync(path.join(exportDir, 'fonts'), { recursive: true });
      fs.mkdirSync(path.join(exportDir, 'media'), { recursive: true });
      fs.mkdirSync(path.join(exportDir, 'assets'), { recursive: true });

      result = { stats: generateExportStats(exportDir, fallbackOptions) };
    } finally {
      await browser.close();
    }
  }

  updateProgress(95, 'Creating ZIP...');

  const zipPath = path.join(exportsDir, `${exportId}.zip`);
  await createZip(exportDir, zipPath);

  const zipStats = fs.statSync(zipPath);
  const fileSize = (zipStats.size / 1024 / 1024).toFixed(2);

  fs.rmSync(exportDir, { recursive: true, force: true });

  updateProgress(100, 'Done!');

  return {
    downloadUrl: `/api/download/${exportId}`,
    fileSize,
    meta: result.stats
  };
}

function createZip(source, dest) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = fs.createWriteStream(dest);

    archive.pipe(stream);
    archive.directory(source, false);
    archive.finalize();

    stream.on('close', resolve);
    archive.on('error', reject);
  });
}

app.post('/api/export', async (req, res) => {
  const { url: inputUrl, options } = req.body;

  if (!inputUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let url = inputUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const exportId = crypto.randomUUID();
  const exportData = {
    status: 'processing',
    progress: 0,
    message: 'Starting...',
    url
  };

  exports.set(exportId, exportData);

  exportWebsite(url, exportId, (progress, message) => {
    const data = exports.get(exportId);
    if (data) {
      data.progress = progress;
      data.message = message;
      exports.set(exportId, data);
    }
  }, options).then(result => {
    const data = exports.get(exportId);
    if (data) {
      data.status = 'completed';
      data.progress = 100;
      data.message = 'Done!';
      data.downloadUrl = result.downloadUrl;
      data.fileSize = result.fileSize;
      data.meta = result.meta;
      exports.set(exportId, data);
      scheduleExportCleanup(exportId);
    }
  }).catch(error => {
    const data = exports.get(exportId);
    if (data) {
      data.status = 'error';
      data.message = error.message;
      exports.set(exportId, data);
    }
  });

  res.json({ exportId, status: 'processing' });
});

app.get('/api/export/:id/status', (req, res) => {
  const { id } = req.params;
  const data = exports.get(id);

  if (!data) {
    return res.status(404).json({ error: 'Export not found' });
  }

  res.json(data);
});

app.get('/api/download/:id', (req, res) => {
  const { id } = req.params;
  const zipPath = path.join(exportsDir, `${id}.zip`);

  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Export not found' });
  }

  res.download(zipPath, 'website-export.zip', (error) => {
    if (error) {
      console.error(`Download failed for ${id}:`, error.message);
      return;
    }

    cleanupExport(id);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

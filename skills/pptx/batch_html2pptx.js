// batch_html2pptx.js
// Convert slide_*.html files into a single .pptx using html2pptx1.js.
//
// Two modes:
//
//  1) Single-directory mode (default — most common after Stage 4):
//       node batch_html2pptx.js <slides_dir> [output.pptx]
//     Converts every slide_*.html under <slides_dir> (sorted) into ONE pptx.
//     If [output.pptx] is omitted, the file is saved next to <slides_dir> as
//     <parent_basename>.pptx (e.g. .../my_deck/slides → .../my_deck/my_deck.pptx).
//
//  2) Batch mode (legacy — walks <base>/ppt_*/download/*/slides):
//       node batch_html2pptx.js --batch <base_dir>
//     Each slides/ folder becomes one .pptx, saved in the parent <name>/ folder.
//
// NODE_PATH=/share/hc/utils/superz/p-p-p-x/ppt0403/node_modules \
//   node batch_html2pptx.js <slides_dir>

const path = require('path');
const fs = require('fs');
const pptxgen = require('pptxgenjs');
const html2pptx = require(path.join(__dirname, 'html2pptx1.js'));

function safeReaddir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true });
}

function findSlidesDirs(baseDir) {
  // Match: <baseDir>/ppt_*/download/*/slides
  const results = [];
  for (const pptDir of safeReaddir(baseDir)) {
    if (!/^ppt_/.test(pptDir.name) || !pptDir.isDirectory()) continue;
    const downloadDir = path.join(baseDir, pptDir.name, 'download');
    for (const sub of safeReaddir(downloadDir)) {
      if (!sub.isDirectory()) continue;
      const slidesDir = path.join(downloadDir, sub.name, 'slides');
      if (fs.existsSync(slidesDir) && fs.statSync(slidesDir).isDirectory()) {
        results.push(slidesDir);
      }
    }
  }
  return results;
}

function collectHtmlFiles(slidesDir) {
  return fs.readdirSync(slidesDir)
    .filter(f => /^slide.*\.html$/i.test(f))
    .sort()
    .map(f => path.join(slidesDir, f));
}

class SlideProcessor {
  constructor(pptx, options = {}) {
    this.pptx = pptx;
    this.options = options;
    this.failures = [];
    this.mustFix = [];
  }

  async processSlide(htmlFile, slide, index, total) {
    const base = path.basename(htmlFile);
    console.log(`    [start ${index + 1}/${total}] ${base}`);
    
    try {
      const { warnings } = await html2pptx(htmlFile, this.pptx, { 
        fontConfig: this.options.fontConfig, 
        slide 
      });
      
      if (warnings && warnings.length > 0) {
        warnings.forEach(w => {
          // Severe overflow is a must-fix signal — surface it loudly but do
          // NOT block output (pptx still writes, exit code stays 0).
          if (w.includes('MUST FIX')) {
            this.mustFix.push({ file: base, message: w });
            console.error(`      ${base}: ${w}`);
          } else {
            console.warn(`      ${base}: ${w}`);
          }
        });
      }
    } catch (err) {
      console.error(`      [error] ${base}: ${err.message}`);
      this.failures.push({ file: htmlFile, error: err });
      if (this.options.strict) throw err;
    } finally {
      console.log(`    [done  ${index + 1}/${total}] ${base}`);
    }
  }

  getFailures() {
    return this.failures;
  }

  getMustFix() {
    return this.mustFix;
  }
}

function createProcessingOptions(options = {}) {
  return {
    strict: options.strict || false,
    fontConfig: options.fontConfig || null,
    concurrency: options.concurrency || 4
  };
}

function preAllocateSlides(pptx, htmlFiles) {
  return htmlFiles.map((htmlFile) => ({
    htmlFile,
    slide: pptx.addSlide(),
  }));
}

async function worker(processor, tasks, startIndex) {
  const total = tasks.length;
  for (let i = startIndex; i < total; i++) {
    await processor.processSlide(tasks[i].htmlFile, tasks[i].slide, i, total);
  }
}

async function buildPptxFromDir(slidesDir, outputPath, options = {}) {
  const processingOptions = createProcessingOptions(options);
  const htmlFiles = collectHtmlFiles(slidesDir);

  if (htmlFiles.length === 0) {
    console.log(`  [skip] no slide_*.html in ${slidesDir}`);
    return null;
  }

  console.log(`  ${htmlFiles.length} slides → ${outputPath} (concurrency=${processingOptions.concurrency})`);

  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';

  const tasks = preAllocateSlides(pptx, htmlFiles);
  const processor = new SlideProcessor(pptx, processingOptions);

  const workerCount = Math.max(1, Math.min(processingOptions.concurrency, tasks.length));
  const workers = [];
  
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker(processor, tasks, i));
  }

  await Promise.all(workers);

  if (processor.getFailures().length > 0) {
    console.warn(`  ${processor.getFailures().length} slide(s) failed during conversion.`);
  }

  // Severe-overflow slides do not block output, but they MUST be fixed — print a
  // consolidated, hard-to-miss list so the caller knows exactly what to re-render.
  if (processor.getMustFix().length > 0) {
    console.error(`\n  🚨🚨 ${processor.getMustFix().length} slide(s) with SEVERE overflow — MUST FIX and re-run:`);
    processor.getMustFix().forEach(({ file, message }) => console.error(`     - ${file}: ${message}`));
    console.error('');
  }

  await pptx.writeFile({ fileName: outputPath });
  console.log(`  saved: ${outputPath}`);
  return outputPath;
}

function defaultOutputPath(slidesDir) {
  // Save the pptx next to the slides/ folder (one folder up),
  // named after the parent directory.
  const parentDir = path.dirname(path.resolve(slidesDir));
  return path.join(parentDir, `${path.basename(parentDir)}.pptx`);
}

async function runSingle(slidesDir, outputPath, options = {}) {
  if (!fs.existsSync(slidesDir) || !fs.statSync(slidesDir).isDirectory()) {
    throw new Error(`slides_dir not found or not a directory: ${slidesDir}`);
  }
  const out = outputPath || defaultOutputPath(slidesDir);
  await buildPptxFromDir(slidesDir, out, options);
}

async function runBatch(baseDir, options = {}) {
  const slidesDirs = findSlidesDirs(baseDir);
  console.log(`Found ${slidesDirs.length} slides directories under ${baseDir}`);

  for (const slidesDir of slidesDirs) {
    const label = path.relative(baseDir, slidesDir);
    console.log(`\nProcessing: ${label}`);
    try {
      const parentDir = path.dirname(slidesDir);
      const outputPath = path.join(parentDir, `${path.basename(parentDir)}.pptx`);
      await buildPptxFromDir(slidesDir, outputPath, options);
    } catch (err) {
      console.error(`  [error] ${slidesDir}: ${err.message}`);
      if (options.strict) throw err;
    }
  }
}

function printUsageAndExit(code = 1) {
  console.error(
    `Usage: node ${path.basename(process.argv[1])} <slides_dir> [output.pptx]\n` +
    `       node ${path.basename(process.argv[1])} --batch <base_dir>\n`
  );
  process.exit(code);
}

// Main entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    printUsageAndExit();
  }

  if (args[0] === '--batch') {
    if (args.length < 2) {
      console.error('Error: --batch requires a base directory argument');
      printUsageAndExit();
    }
    runBatch(args[1]).catch(err => {
      console.error(`Batch processing failed: ${err.message}`);
      process.exit(1);
    });
  } else {
    const slidesDir = args[0];
    const outputPath = args[1];
    runSingle(slidesDir, outputPath).catch(err => {
      console.error(`Processing failed: ${err.message}`);
      process.exit(1);
    });
  }
}

module.exports = {
  safeReaddir,
  findSlidesDirs,
  collectHtmlFiles,
  buildPptxFromDir,
  defaultOutputPath,
  runSingle,
  runBatch,
  SlideProcessor,
  createProcessingOptions,
  preAllocateSlides
};
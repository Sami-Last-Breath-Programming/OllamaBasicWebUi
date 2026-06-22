const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const PDF_TYPE = 'application/pdf';

export function getFileIcon(name) {
  const ext = '.' + name.split('.').pop().toLowerCase();
  if (['.py'].includes(ext)) return '🐍';
  if (['.js','.ts'].includes(ext)) return '📜';
  if (['.java'].includes(ext)) return '☕';
  if (['.c','.cpp'].includes(ext)) return '⚙️';
  if (['.json'].includes(ext)) return '📋';
  if (['.md'].includes(ext)) return '📝';
  if (['.html','.css'].includes(ext)) return '🌐';
  if (['.jpg','.jpeg','.png','.gif','.webp'].includes(ext)) return '🖼️';
  if (['.pdf'].includes(ext)) return '📕';
  return '📄';
}

export async function readFile(file) {
  if (file.type === PDF_TYPE || file.name.toLowerCase().endsWith('.pdf')) {
    return await readPdf(file);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    if (IMAGE_TYPES.includes(file.type)) {
      reader.onload = e => resolve({
        name: file.name,
        type: 'image',
        mimeType: file.type,
        data: e.target.result
      });
      reader.onerror = reject;
      reader.readAsDataURL(file);
    } else {
      reader.onload = e => resolve({
        name: file.name,
        type: 'text',
        mimeType: 'text/plain',
        data: e.target.result
      });
      reader.onerror = reject;
      reader.readAsText(file);
    }
  });
}

async function readPdf(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const typedArray = new Uint8Array(e.target.result);
        if (typeof pdfjsLib !== 'undefined') {
          // Use fake worker to avoid worker loading issues
          pdfjsLib.GlobalWorkerOptions.workerSrc = '';
          const pdf = await pdfjsLib.getDocument({ data: typedArray, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
          let fullText = `PDF: ${file.name} (${pdf.numPages} pages)\n\n`;
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map(item => item.str).join(' ');
            fullText += `--- Page ${i} ---\n${pageText}\n\n`;
          }
          resolve({
            name: file.name,
            type: 'text',
            mimeType: 'text/plain',
            data: fullText,
            isPdf: true
          });
        } else {
          resolve({
            name: file.name,
            type: 'text',
            mimeType: 'text/plain',
            data: `[PDF file: ${file.name} — PDF.js not loaded, cannot extract text]`
          });
        }
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export function buildFileMessage(files) {
  let content = '';
  for (const f of files) {
    if (f.type === 'text') {
      content += `\n\n📄 **${f.name}**:\n\`\`\`\n${f.data}\n\`\`\``;
    }
    // images handled separately via images[] field
  }
  return content;
}

export function buildOllamaMessages(history) {
  return history.map(msg => {
    const files = msg.files || [];
    const imageFiles = files.filter(f => f.type === 'image');

    const entry = {
      role: msg.role,
      content: msg.content || ''
    };

    if (imageFiles.length > 0) {
      // ✅ Strip the "data:image/png;base64," prefix — send raw base64 only
      entry.images = imageFiles.map(f => {
        const raw = f.data;
        const commaIdx = raw.indexOf(',');
        return commaIdx !== -1 ? raw.substring(commaIdx + 1) : raw;
      });
    }

    return entry;
  });
}

import JSZip from 'jszip';

export async function processZipFile(file: File): Promise<{ path: string; content: string }[]> {
  const zip = new JSZip();
  const files: { path: string; content: string }[] = [];

  try {
    const zipContent = await zip.loadAsync(file);
    
    const processEntries = async () => {
      const promises = [];
      
      zipContent.forEach((relativePath, entry) => {
        if (!entry.dir) {
          promises.push(
            entry.async('string').then(content => {
              files.push({
                path: relativePath,
                content
              });
            })
          );
        }
      });
      
      await Promise.all(promises);
    };

    await processEntries();
    return files;
  } catch (error) {
    console.error('Error processing zip file:', error);
    throw new Error('Failed to process zip file');
  }
}
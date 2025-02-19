import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: import.meta.env.VITE_OPENAI_API_KEY,
  dangerouslyAllowBrowser: true // Enable browser usage
});

export interface IntegrationPlan {
  title: string;
  description: string;
  files: Array<{
    path: string;
    content: string;
    additions: number;
    deletions: number;
  }>;
}

function countChanges(content: string): { additions: number; deletions: number } {
  const lines = content.split('\n');
  const additions = lines.filter(line => line.startsWith('+')).length;
  const deletions = lines.filter(line => line.startsWith('-')).length;
  return { additions, deletions };
}

function extractDependencies(content: string): string[] {
  const dependencies: string[] = [];
  
  // Match import statements
  const importRegex = /import\s+(?:{[^}]+}|\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  
  while ((match = importRegex.exec(content)) !== null) {
    const dependency = match[1];
    if (!dependency.startsWith('.') && !dependency.startsWith('/')) {
      dependencies.push(dependency);
    }
  }
  
  // Match require statements
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const dependency = match[1];
    if (!dependency.startsWith('.') && !dependency.startsWith('/')) {
      dependencies.push(dependency);
    }
  }
  
  return [...new Set(dependencies)];
}

function parsePackageJson(content: string): Record<string, string> {
  try {
    const packageJson = JSON.parse(content);
    return {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {})
    };
  } catch {
    return {};
  }
}

function analyzeDirectoryStructure(
  structure: Array<{ path: string; type: 'file' | 'directory' }>,
): {
  directories: string[];
  patterns: {
    components?: string;
    hooks?: string;
    utils?: string;
    types?: string;
    pages?: string;
    features?: string;
  };
} {
  const directories = structure
    .filter(item => item.type === 'directory')
    .map(item => item.path);

  const patterns = {
    components: directories.find(dir => 
      dir.includes('components') || dir.includes('ui')
    ),
    hooks: directories.find(dir => 
      dir.includes('hooks')
    ),
    utils: directories.find(dir => 
      dir.includes('utils') || dir.includes('lib') || dir.includes('helpers')
    ),
    types: directories.find(dir => 
      dir.includes('types') || dir.includes('interfaces')
    ),
    pages: directories.find(dir => 
      dir.includes('pages') || dir.includes('routes')
    ),
    features: directories.find(dir => 
      dir.includes('features') || dir.includes('modules')
    ),
  };

  return { directories, patterns };
}

export async function generateIntegrationPlan(
  prototypeFiles: Array<{ path: string; content: string }>,
  targetRepo: {
    name: string;
    structure: Array<{ path: string; type: 'file' | 'directory'; content?: string }>;
  }
): Promise<IntegrationPlan> {
  // Extract dependencies from prototype files
  const prototypeDependencies = prototypeFiles
    .map(file => extractDependencies(file.content))
    .flat();

  // Find package.json in target repo
  const packageJsonFile = targetRepo.structure.find(
    file => file.path === 'package.json' && file.type === 'file'
  );

  // Parse existing dependencies
  const existingDependencies = packageJsonFile?.content
    ? parsePackageJson(packageJsonFile.content)
    : {};

  // Analyze dependencies
  const dependencyAnalysis = prototypeDependencies.map(dep => {
    const basePkg = dep.split('/')[0]; // Handle scoped packages
    const alternatives = Object.keys(existingDependencies).filter(existing => {
      // Common alternative packages
      const alternatives: Record<string, string[]> = {
        'axios': ['fetch', 'node-fetch', 'got', 'ky', 'superagent'],
        'moment': ['date-fns', 'dayjs', 'luxon'],
        'lodash': ['ramda', 'underscore'],
        'next-auth': ['@auth/core', 'firebase-auth'],
        'styled-components': ['@emotion/styled', '@stitches/react', 'tailwindcss'],
        'redux': ['zustand', 'jotai', 'recoil', '@tanstack/react-query'],
      };

      return alternatives[basePkg]?.includes(existing) || false;
    });

    return {
      package: dep,
      existingAlternative: alternatives.length > 0 ? alternatives[0] : null
    };
  });

  // Analyze directory structure
  const { directories, patterns } = analyzeDirectoryStructure(targetRepo.structure);

  const prompt = `You are an expert software developer tasked with integrating prototype code into a production codebase.

Context:
- Target Repository: ${targetRepo.name}
- Repository Structure: ${JSON.stringify(targetRepo.structure, null, 2)}
- Prototype Files: ${prototypeFiles.map(f => f.path).join(', ')}

Directory Analysis:
- Existing Directories: ${directories.join(', ')}
- Component Location: ${patterns.components || 'Not found'}
- Hooks Location: ${patterns.hooks || 'Not found'}
- Utils Location: ${patterns.utils || 'Not found'}
- Types Location: ${patterns.types || 'Not found'}
- Pages/Routes Location: ${patterns.pages || 'Not found'}
- Features Location: ${patterns.features || 'Not found'}

Dependency Analysis:
${JSON.stringify(dependencyAnalysis, null, 2)}

Task:
Create a detailed, step-by-step integration plan that explains the reasoning behind each decision. For each step:

1. Directory Structure:
   - Analyze where each prototype file should be placed
   - Explain why that location is optimal
   - Consider creating new directories if needed
   - Justify any new directory creation
   - Explain how it fits with existing patterns

2. Code Adaptation:
   - Identify framework-specific code that needs translation
   - Explain the translation approach
   - List specific changes needed
   - Provide reasoning for each change

3. Dependency Management:
   - Review each external dependency
   - Identify opportunities to use existing packages
   - Explain why each package decision was made
   - Consider bundle size and maintenance impact

4. Integration Steps:
   - Provide a clear sequence of implementation steps
   - Explain dependencies between steps
   - Identify potential risks
   - Suggest testing approaches

5. Code Style and Patterns:
   - Analyze existing code style
   - Identify pattern mismatches
   - Explain required adjustments
   - Justify style decisions

For each file in the plan, include:
1. Final file path with justification
2. Complete file content after changes
3. Detailed explanation of changes
4. Impact analysis
5. Testing recommendations

Consider:
- Existing directory patterns and naming conventions
- Similar component/feature locations
- Project organization (e.g., feature-based vs. type-based)
- Dependency proximity (related files should be close)
- Scalability of the chosen structure
- Potential conflicts or breaking changes
- Performance implications
- Testing requirements
- Maintenance impact

Prototype Files Content:
${prototypeFiles.map(f => `${f.path}:\n${f.content}`).join('\n')}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'o3-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert software developer specializing in code integration and migration. Respond with a JSON object containing "title", "description", and "files" array with "path" and "content" for each file. The description should include a clear, step-by-step integration plan with reasoning for each decision.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
    });

    const plan = JSON.parse(response.choices[0].message.content) as IntegrationPlan;
    
    // Add line change counts
    const filesWithChanges = plan.files.map(file => ({
      ...file,
      ...countChanges(file.content),
    }));

    return {
      title: plan.title,
      description: plan.description,
      files: filesWithChanges,
    };
  } catch (error) {
    console.error('Error generating integration plan:', error);
    throw new Error('Failed to generate integration plan. Please check your OpenAI API key and try again.');
  }
}
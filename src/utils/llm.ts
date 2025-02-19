import OpenAI from 'openai';
import { Buffer } from 'buffer';

// Initialize OpenAI with global Buffer
(window as any).Buffer = Buffer;

const openai = new OpenAI({
  apiKey: import.meta.env.VITE_OPENAI_API_KEY,
  dangerouslyAllowBrowser: true, // Enable browser usage
});

const MODEL = 'o3-mini';

export interface IntegrationPlan {
  title: string;
  description: string;
  files: Array<{
    path: string;
    content: string;
    additions: number;
    deletions: number;
    originalPath?: string;
    changes?: string[];
  }>;
}

interface DirectoryStructure {
  [key: string]: {
    type: 'file' | 'directory';
    children?: DirectoryStructure;
  };
}

function buildDirectoryStructure(
  items: Array<{ path: string; type: 'file' | 'directory' }>
): DirectoryStructure {
  const structure: DirectoryStructure = {};

  items.forEach((item) => {
    const parts = item.path.split('/');
    let current = structure;

    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        // Last part - add the file/directory
        current[part] = {
          type: item.type,
          children: item.type === 'directory' ? {} : undefined,
        };
      } else {
        // Create intermediate directories if they don't exist
        if (!current[part]) {
          current[part] = {
            type: 'directory',
            children: {},
          };
        }
        current = current[part].children!;
      }
    });
  });

  return structure;
}

function countChanges(content: string): {
  additions: number;
  deletions: number;
} {
  const lines = content.split('\n');
  const additions = lines.filter((line) => line.startsWith('+')).length;
  const deletions = lines.filter((line) => line.startsWith('-')).length;
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

function parsePackageJson(content: string): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  try {
    const packageJson = JSON.parse(content);
    return {
      dependencies: packageJson.dependencies || {},
      devDependencies: packageJson.devDependencies || {},
    };
  } catch {
    return { dependencies: {}, devDependencies: {} };
  }
}

interface ProjectStructureAnalysis {
  frontendDirectory: string | null;
  projectType: {
    framework:
      | 'react'
      | 'vue'
      | 'angular'
      | 'next.js'
      | 'nuxt'
      | 'svelte'
      | 'unknown';
    meta: {
      isTypescript: boolean;
      styling:
        | 'tailwind'
        | 'styled-components'
        | 'css-modules'
        | 'sass'
        | 'emotion'
        | 'unknown';
      stateManagement:
        | 'redux'
        | 'mobx'
        | 'recoil'
        | 'zustand'
        | 'jotai'
        | 'unknown';
    };
  };
  directories: {
    components?: string;
    hooks?: string;
    utils?: string;
    types?: string;
    pages?: string;
    features?: string;
  };
  structure: DirectoryStructure;
}

function analyzeProjectStructure(
  structure: Array<{
    path: string;
    type: 'file' | 'directory';
    content?: string;
  }>
): ProjectStructureAnalysis {
  // Find package.json to analyze dependencies
  const packageJson = structure.find(
    (file) => file.path === 'package.json' && file.type === 'file'
  );
  const { dependencies, devDependencies } = packageJson?.content
    ? parsePackageJson(packageJson.content)
    : { dependencies: {}, devDependencies: {} };

  const allDeps = { ...dependencies, ...devDependencies };

  // Build nested directory structure
  const directoryStructure = buildDirectoryStructure(structure);

  // Detect frontend directory
  const potentialFrontendDirs = ['src', 'app', 'client', 'frontend', 'web'];
  const frontendDir =
    structure
      .filter((item) => item.type === 'directory')
      .find((dir) => potentialFrontendDirs.includes(dir.path.toLowerCase()))
      ?.path || null;

  // Detect framework
  let framework: ProjectStructureAnalysis['projectType']['framework'] =
    'unknown';
  if (allDeps['next'] || allDeps['next.js']) framework = 'next.js';
  else if (allDeps['nuxt']) framework = 'nuxt';
  else if (allDeps['@angular/core']) framework = 'angular';
  else if (allDeps['vue']) framework = 'vue';
  else if (allDeps['svelte']) framework = 'svelte';
  else if (allDeps['react']) framework = 'react';

  // Detect TypeScript
  const isTypescript = Boolean(
    allDeps['typescript'] ||
      structure.some(
        (file) => file.path.endsWith('.ts') || file.path.endsWith('.tsx')
      )
  );

  // Detect styling solution
  let styling: ProjectStructureAnalysis['projectType']['meta']['styling'] =
    'unknown';
  if (allDeps['tailwindcss']) styling = 'tailwind';
  else if (allDeps['styled-components']) styling = 'styled-components';
  else if (allDeps['@emotion/react']) styling = 'emotion';
  else if (structure.some((file) => file.path.endsWith('.module.css')))
    styling = 'css-modules';
  else if (structure.some((file) => file.path.endsWith('.scss')))
    styling = 'sass';

  // Detect state management
  let stateManagement: ProjectStructureAnalysis['projectType']['meta']['stateManagement'] =
    'unknown';
  if (allDeps['redux'] || allDeps['@reduxjs/toolkit'])
    stateManagement = 'redux';
  else if (allDeps['mobx']) stateManagement = 'mobx';
  else if (allDeps['recoil']) stateManagement = 'recoil';
  else if (allDeps['zustand']) stateManagement = 'zustand';
  else if (allDeps['jotai']) stateManagement = 'jotai';

  // Analyze directory structure
  const directories = structure
    .filter((item) => item.type === 'directory')
    .map((item) => item.path);

  const patterns = {
    components: directories.find(
      (dir) => dir.includes('components') || dir.includes('ui')
    ),
    hooks: directories.find((dir) => dir.includes('hooks')),
    utils: directories.find(
      (dir) =>
        dir.includes('utils') || dir.includes('lib') || dir.includes('helpers')
    ),
    types: directories.find(
      (dir) => dir.includes('types') || dir.includes('interfaces')
    ),
    pages: directories.find(
      (dir) => dir.includes('pages') || dir.includes('routes')
    ),
    features: directories.find(
      (dir) => dir.includes('features') || dir.includes('modules')
    ),
  };

  return {
    frontendDirectory: frontendDir,
    projectType: {
      framework,
      meta: {
        isTypescript,
        styling,
        stateManagement,
      },
    },
    directories: patterns,
    structure: directoryStructure,
  };
}

export async function generateIntegrationPlan(
  prototypeFiles: Array<{ path: string; content: string }>,
  targetRepo: {
    name: string;
    structure: Array<{
      path: string;
      type: 'file' | 'directory';
      content?: string;
    }>;
  }
): Promise<IntegrationPlan> {
  // Extract dependencies from prototype files
  const prototypeDependencies = prototypeFiles
    .map((file) => extractDependencies(file.content))
    .flat();

  // Analyze project structure
  const projectAnalysis = analyzeProjectStructure(targetRepo.structure);

  // Find package.json in target repo
  const packageJsonFile = targetRepo.structure.find(
    (file) => file.path === 'package.json' && file.type === 'file'
  );

  // Parse existing dependencies
  const { dependencies: existingDependencies } = packageJsonFile?.content
    ? parsePackageJson(packageJsonFile.content)
    : { dependencies: {} };

  // Analyze dependencies
  const dependencyAnalysis = prototypeDependencies.map((dep) => {
    const basePkg = dep.split('/')[0];
    const alternatives = Object.keys(existingDependencies).filter(
      (existing) => {
        const alternatives: Record<string, string[]> = {
          axios: ['fetch', 'node-fetch', 'got', 'ky', 'superagent'],
          moment: ['date-fns', 'dayjs', 'luxon'],
          lodash: ['ramda', 'underscore'],
          'next-auth': ['@auth/core', 'firebase-auth'],
          'styled-components': [
            '@emotion/styled',
            '@stitches/react',
            'tailwindcss',
          ],
          redux: ['zustand', 'jotai', 'recoil', '@tanstack/react-query'],
        };

        return alternatives[basePkg]?.includes(existing) || false;
      }
    );

    return {
      package: dep,
      existingAlternative: alternatives.length > 0 ? alternatives[0] : null,
    };
  });

  const prompt = `You are an expert software developer tasked with integrating prototype code into a production codebase.

Context:
- Target Repository: ${targetRepo.name}
- Frontend Directory: ${projectAnalysis.frontendDirectory || 'Not detected'}
- Framework: ${projectAnalysis.projectType.framework}
- TypeScript: ${projectAnalysis.projectType.meta.isTypescript ? 'Yes' : 'No'}
- Styling: ${projectAnalysis.projectType.meta.styling}
- State Management: ${projectAnalysis.projectType.meta.stateManagement}

Directory Structure:
${JSON.stringify(projectAnalysis.structure, null, 2)}

Dependency Analysis:
${JSON.stringify(dependencyAnalysis, null, 2)}

Task:
Create a concise integration plan that focuses on:

1. File Organization:
   - Target location for each file (considering the detected frontend directory)
   - New directories needed
   - Naming conventions to follow

2. Required Modifications:
   - Framework adaptations needed
   - Code style adjustments
   - Dependency changes

3. Integration Steps:
   - Clear sequence of changes
   - Testing approach
   - Potential risks

Keep the plan brief but informative. Include specific file paths and key changes needed.

For each file, provide:
1. Final path (relative to the detected frontend directory)
2. Required changes
3. Testing notes

Format the plan as a clear markdown document that will be included in the PR.

Prototype Files:
${prototypeFiles.map((f) => `${f.path}:\n${f.content}`).join('\n')}`;

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      // if model is o3-mini or other reasoning model, comment out temperature
      // temperature: 0.7,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert software developer specializing in code integration and migration. Respond with a JSON object containing "title", "description", and "files" array. Each file should include "path", "content", "originalPath" (if different from path), and "changes" (array of specific modifications needed).',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
    });

    const response = JSON.parse(completion.choices[0].message.content);

    // Transform the response into the expected format
    const plan: IntegrationPlan = {
      title: response.title,
      description: response.description,
      files: response.files.map((file: any) => ({
        path: file.path,
        // If no content is provided, use a placeholder based on the changes
        content: file.content || file.changes.join('\n'),
        additions: 0,
        deletions: 0,
        changes: file.changes,
        originalPath: file.originalPath,
      })),
    };

    // Add line change counts
    const filesWithChanges = plan.files.map((file) => ({
      ...file,
      ...countChanges(file.content),
    }));

    // Create integration_plan.md
    const integrationPlanMd = `# ${plan.title}\n\n${plan.description}`;
    filesWithChanges.push({
      path: 'integration_plan.md',
      content: integrationPlanMd,
      additions: integrationPlanMd.split('\n').length,
      deletions: 0,
    });

    return {
      title: plan.title,
      description: plan.description,
      files: filesWithChanges,
    };
  } catch (error) {
    console.error('Error generating integration plan:', error);
    throw new Error(
      'Failed to generate integration plan. Please check your OpenAI API key and try again.'
    );
  }
}

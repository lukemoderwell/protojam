import { Buffer } from 'buffer';
import { z } from 'zod';
import { generateObject } from 'ai';
import { o3MiniModel } from './providers';
import { systemPrompt } from './prompt';
// Initialize OpenAI with global Buffer
(window as any).Buffer = Buffer;

const MODEL = o3MiniModel;

const DirectoryAnalysisSchema = z.object({
  nextjsRoot: z.string(),
  pagesDirectory: z.string(),
  prototypePath: z.string(),
  recommendations: z.array(z.string()),
  compatibility: z.object({
    framework: z.string(),
    styling: z.string(),
    dependencies: z.array(z.string()),
    nextjsVersion: z.string(),
  }),
});

export type DirectoryAnalysis = z.infer<typeof DirectoryAnalysisSchema>;

export async function analyzeDirectories(
  prototypeFiles: Array<{ path: string; content: string }>,
  targetRepo: {
    name: string;
    structure: Array<{
      path: string;
      type: 'file' | 'directory';
      content?: string;
    }>;
  }
): Promise<DirectoryAnalysis> {
  const prompt = `Task:
Analyze the target NextJS repository structure and prototype files to:
1. Identify the NextJS root directory
2. Determine if using pages/ or app/ directory
3. Generate a unique, SEO-friendly route path for the prototype
4. Assess compatibility and required adaptations

Prototype Files:
${prototypeFiles.map((f) => `${f.path}:\n${f.content}`).join('\n')}

Target Repository Structure:
${JSON.stringify(targetRepo.structure, null, 2)}

Respond with a JSON object:
{
  "nextjsRoot": string,
  "pagesDirectory": string,
  "prototypePath": string,
  "recommendations": string[],
  "compatibility": {
    "framework": string,
    "styling": string,
    "dependencies": string[],
    "nextjsVersion": string
  }
}`;

  try {
    const res = await generateObject({
      model: MODEL,
      system: systemPrompt(),
      prompt,
      schema: DirectoryAnalysisSchema,
    });

    return res.object;
  } catch (error) {
    console.error('Error analyzing directories:', error);
    throw new Error(
      'Failed to analyze codebases. Please check your OpenAI API key and try again.'
    );
  }
}

const PullRequestPlanSchema = z.object({
  title: z.string(),
  description: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      tasks: z.array(z.string()),
    })
  ),
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
    })
  ),
  route: z.string(),
});

export type PullRequestPlan = z.infer<typeof PullRequestPlanSchema>;

export async function generatePullRequestPlan(
  prototypeFiles: Array<{ path: string; content: string }>,
  targetRepo: {
    name: string;
    structure: Array<{
      path: string;
      type: 'file' | 'directory';
      content?: string;
    }>;
  }
): Promise<PullRequestPlan> {
  // First analyze directories
  const analysis = await analyzeDirectories(prototypeFiles, targetRepo);

  const prompt = `Context:
- Target Repository: ${targetRepo.name}
- Analysis: ${JSON.stringify(analysis, null, 2)}

Task:
Create a detailed pull request plan for NextJS integration:
1. Clear title and description explaining the prototype integration
2. Step-by-step guide for adding the prototype as a new page
3. Required file changes and their locations
4. Testing guidelines

Prototype Files:
${prototypeFiles.map((f) => `${f.path}:\n${f.content}`).join('\n')}`;

  try {
    const res = await generateObject({
      model: MODEL,
      system: systemPrompt(),
      prompt,
      schema: PullRequestPlanSchema,
    });

    return res.object;
  } catch (error) {
    console.error('Error generating pull request plan:', error);
    throw new Error(
      'Failed to generate integration plan. Please check your OpenAI API key and try again.'
    );
  }
}

const IntegrationPlanSchema = z.object({
  targetDirectory: z.string(),
  integrationSteps: z.array(z.string()),
  pullRequest: z.object({
    title: z.string(),
    description: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        content: z.string(),
      })
    ),
    route: z.string(),
  }),
});

export type IntegrationPlan = z.infer<typeof IntegrationPlanSchema>;

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
  const _systemPrompt =
    systemPrompt() +
    `You are an expert software developer tasked with integrating a prototype app into a legacy NextJS codebase.`;

  const prompt = `Context:
- Target Repository: ${targetRepo.name}
- Target Repository Structure: 
${JSON.stringify(targetRepo.structure, null, 2)}

- Prototype Files:
${prototypeFiles.map((f) => `${f.path}:\n${f.content}`).join('\n')}

Task:
1. Analyze the target NextJS repository structure and prototype files 
2. Identify the best directory to place the prototype app
3. Provide step-by-step instructions to build and deploy the integrated prototype app
4. Generate a pull request title and description for integrating the prototype
5. Provide the necessary files to be included in the pull request

Respond with a JSON object containing:
{
  "targetDirectory": string,
  "integrationSteps": string[],
  "pullRequest": {
    "title": string,
    "description": string,
    "route": string,
    "files": [
      {
        "path": string,
        "content": string
      }
    ]
  }
}`;

  try {
    const res = await generateObject({
      model: MODEL,
      system: _systemPrompt,
      prompt,
      schema: IntegrationPlanSchema,
    });

    return res.object;
  } catch (error) {
    console.error('Error generating integration plan:', error);
    throw new Error(
      'Failed to generate integration plan. Please check your OpenAI API key and try again.'
    );
  }
}

export interface DirectoryStructure {
  [key: string]: {
    type: 'file' | 'directory';
    children?: DirectoryStructure;
  };
}

export function buildDirectoryStructure(
  files: Array<{ path: string; type: 'file' | 'directory' }>
): DirectoryStructure {
  const structure: DirectoryStructure = {};

  files.forEach((file) => {
    const parts = file.path.split('/');
    let current = structure;

    parts.forEach((part, index) => {
      if (!current[part]) {
        current[part] = {
          type: index === parts.length - 1 ? file.type : 'directory',
          children: index === parts.length - 1 ? undefined : {},
        };
      }
      current = current[part].children || {};
    });
  });

  return structure;
}

export function calculateFileChanges(
  files: Array<{ path: string; content: string }>,
  existingFiles: Array<{ path: string; content: string }>
): { additions: number; deletions: number } {
  const additions = files.reduce((sum, file) => {
    const lines = file.content.split('\n').length;
    return sum + lines;
  }, 0);

  const deletions = existingFiles.reduce((sum, file) => {
    const lines = file.content.split('\n').length;
    return sum + lines;
  }, 0);

  return { additions, deletions };
}

export function extractDependencies(content: string): string[] {
  const dependencies: string[] = [];

  // Match import statements
  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const dep = match[1];
    if (!dep.startsWith('.')) {
      dependencies.push(dep);
    }
  }

  // Match require statements
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const dep = match[1];
    if (!dep.startsWith('.')) {
      dependencies.push(dep);
    }
  }

  return [...new Set(dependencies)];
}

export function parsePackageJson(content: string): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} {
  try {
    const parsed = JSON.parse(content);
    return {
      dependencies: parsed.dependencies || {},
      devDependencies: parsed.devDependencies || {},
    };
  } catch (error) {
    console.error('Error parsing package.json:', error);
    return {
      dependencies: {},
      devDependencies: {},
    };
  }
}

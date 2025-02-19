import React, { useState, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { Octokit } from '@octokit/rest';
import { Github, Upload, Code2, GitPullRequest, Loader2, FileCode, Plus, Minus, ChevronDown, ChevronRight, Lock, Folder, FolderOpen, File, AlertCircle } from 'lucide-react';
import { processZipFile } from './utils/zipHandler';
import { generateIntegrationPlan, type IntegrationPlan } from './utils/llm';
import { createPullRequest } from './utils/github';

interface UploadState {
  status: 'idle' | 'uploading' | 'processing' | 'success' | 'error';
  message?: string;
}

interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  content: string;
}

interface Repository {
  full_name: string;
  description: string;
  private: boolean;
  updated_at: string;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
  isTarget?: boolean;
}

interface LLMRequest {
  prototypeFiles: {
    path: string;
    content: string;
  }[];
  targetRepo: {
    structure: {
      path: string;
      type: 'file' | 'directory';
      content?: string;
    }[];
    name: string;
  };
}

function buildTreeFromPaths(
  items: Array<{ path: string; type: 'file' | 'directory' }>,
  targetPaths: string[] = []
): TreeNode[] {
  const root: { [key: string]: TreeNode } = {};

  items.forEach(item => {
    const parts = item.path.split('/');
    let current = root;

    parts.forEach((part, index) => {
      if (!current[part]) {
        current[part] = {
          name: part,
          path: parts.slice(0, index + 1).join('/'),
          type: index === parts.length - 1 ? item.type : 'directory',
          children: {},
          isTarget: targetPaths.includes(parts.slice(0, index + 1).join('/'))
        };
      }
      if (index < parts.length - 1) {
        current = current[part].children as { [key: string]: TreeNode };
      }
    });
  });

  const convertToArray = (node: { [key: string]: TreeNode }): TreeNode[] => {
    return Object.values(node).map(item => ({
      ...item,
      children: item.children ? convertToArray(item.children as { [key: string]: TreeNode }) : undefined
    }));
  };

  return convertToArray(root);
}

function DirectoryTree({ 
  node, 
  level = 0,
  defaultExpanded = false
}: { 
  node: TreeNode; 
  level?: number;
  defaultExpanded?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded || node.isTarget);
  const paddingLeft = `${level * 1.5}rem`;

  if (node.type === 'file') {
    return (
      <div 
        className={`flex items-center py-1 hover:bg-gray-700/30 rounded px-2 ${node.isTarget ? 'bg-blue-500/20' : ''}`}
        style={{ paddingLeft }}
      >
        <File className="h-4 w-4 text-gray-400 mr-2" />
        <span className="text-sm">{node.name}</span>
      </div>
    );
  }

  return (
    <div>
      <button
        className={`flex items-center py-1 hover:bg-gray-700/30 rounded px-2 w-full text-left ${
          node.isTarget ? 'bg-blue-500/20' : ''
        }`}
        style={{ paddingLeft }}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-gray-400 mr-1" />
        ) : (
          <ChevronRight className="h-4 w-4 text-gray-400 mr-1" />
        )}
        {isExpanded ? (
          <FolderOpen className="h-4 w-4 text-gray-400 mr-2" />
        ) : (
          <Folder className="h-4 w-4 text-gray-400 mr-2" />
        )}
        <span className="text-sm">{node.name}</span>
      </button>
      {isExpanded && node.children && (
        <div>
          {node.children.map((child, index) => (
            <DirectoryTree 
              key={child.path} 
              node={child} 
              level={level + 1}
              defaultExpanded={defaultExpanded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileChangePreview({ file }: { file: FileChange }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 bg-gray-800 flex items-center justify-between hover:bg-gray-750 transition-colors"
      >
        <div className="flex items-center space-x-3">
          <FileCode className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium">{file.path}</span>
        </div>
        <div className="flex items-center space-x-4">
          <span className="text-sm text-green-400 flex items-center">
            <Plus className="h-3 w-3 mr-1" />
            {file.additions}
          </span>
          <span className="text-sm text-red-400 flex items-center">
            <Minus className="h-3 w-3 mr-1" />
            {file.deletions}
          </span>
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          )}
        </div>
      </button>
      {isExpanded && (
        <div className="bg-gray-900 p-4 overflow-x-auto">
          <pre className="text-sm font-mono">
            <code>{file.content}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

function App() {
  const [prototypeUrl, setPrototypeUrl] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [uploadState, setUploadState] = useState<UploadState>({ status: 'idle' });
  const [showPRPreview, setShowPRPreview] = useState(false);
  const [token, setToken] = useState('');
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');
  const [showRepoDropdown, setShowRepoDropdown] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [llmRequest, setLlmRequest] = useState<LLMRequest | null>(null);
  const [integrationPlan, setIntegrationPlan] = useState<IntegrationPlan | null>(null);
  const [repoTree, setRepoTree] = useState<TreeNode[]>([]);
  const [isPRCreating, setIsPRCreating] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (acceptedFiles) => {
      handleFileUpload(acceptedFiles);
    },
  });

  useEffect(() => {
    if (token) {
      fetchRepositories();
    }
  }, [token]);

  useEffect(() => {
    if (integrationPlan && llmRequest) {
      const targetPaths = integrationPlan.files.map(file => {
        const parts = file.path.split('/');
        return parts.slice(0, -1).join('/');
      });

      const tree = buildTreeFromPaths(
        llmRequest.targetRepo.structure,
        targetPaths
      );
      setRepoTree(tree);
    }
  }, [integrationPlan, llmRequest]);

  const fetchRepositories = async () => {
    try {
      const octokit = new Octokit({ auth: token });
      
      // First verify the token has correct scopes
      const { data: user } = await octokit.users.getAuthenticated();
      
      const response = await octokit.repos.listForAuthenticatedUser({
        sort: 'updated',
        per_page: 100,
      });
      setRepositories(response.data);
      setIsAuthenticated(true);
    } catch (error) {
      console.error('Failed to fetch repositories:', error);
      setIsAuthenticated(false);
      setToken('');
      setUploadState({
        status: 'error',
        message: 'Authentication failed. Please ensure your token has the "repo" scope.'
      });
    }
  };

  const handleFileUpload = async (files: File[]) => {
    setUploadState({ status: 'uploading' });
    
    try {
      // Read file contents
      const prototypeFiles = await Promise.all(
        files.map(async (file) => {
          if (file.name.endsWith('.zip')) {
            return processZipFile(file);
          } else {
            return [{
              path: file.name,
              content: await file.text()
            }];
          }
        })
      );

      // Prepare LLM request data
      if (selectedRepo) {
        const octokit = new Octokit({ auth: token });
        const [owner, repo] = selectedRepo.split('/');
        
        try {
          // Fetch repository structure
          const { data: repoContents } = await octokit.repos.getContent({
            owner,
            repo,
            path: ''
          });

          const llmRequestData: LLMRequest = {
            prototypeFiles: prototypeFiles.flat(),
            targetRepo: {
              name: selectedRepo,
              structure: Array.isArray(repoContents) ? repoContents.map(item => ({
                path: item.path,
                type: item.type as 'file' | 'directory',
                content: item.type === 'file' ? item.content : undefined
              })) : []
            }
          };

          setLlmRequest(llmRequestData);
          setUploadState({ 
            status: 'success',
            message: 'Files uploaded successfully. Click "Analyze Integration" to proceed.'
          });
        } catch (error: any) {
          if (error.status === 403) {
            setUploadState({
              status: 'error',
              message: 'Unable to access repository. Please ensure your token has the "repo" scope and you have access to this repository.'
            });
          } else {
            setUploadState({
              status: 'error',
              message: 'Failed to analyze repository structure. Please try again.'
            });
          }
        }
      }
    } catch (error) {
      console.error('Failed to process files:', error);
      setUploadState({
        status: 'error',
        message: 'Failed to process files. Please try again.'
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated || !selectedRepo || !llmRequest) return;
    
    setUploadState({ 
      status: 'processing',
      message: 'Analyzing code and preparing integration plan...'
    });

    try {
      const plan = await generateIntegrationPlan(
        llmRequest.prototypeFiles,
        llmRequest.targetRepo
      );
      
      setIntegrationPlan(plan);
      setUploadState({ 
        status: 'success',
        message: 'Analysis complete! Review the integration plan below.'
      });
      setShowPRPreview(true);
    } catch (error) {
      setUploadState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to generate integration plan'
      });
    }
  };

  const handleTokenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploadState({ status: 'processing', message: 'Verifying token permissions...' });
    
    try {
      const octokit = new Octokit({ auth: token });
      
      // First verify the token has correct scopes
      const { data: { permissions } } = await octokit.users.getAuthenticated();
      
      // Check if token has the required permissions
      if (!permissions?.contents || !permissions?.pull_requests) {
        throw new Error('Token requires "repo" scope for full repository access');
      }

      const response = await octokit.repos.listForAuthenticatedUser({
        sort: 'updated',
        per_page: 100,
      });
      
      setRepositories(response.data);
      setIsAuthenticated(true);
      setUploadState({ status: 'success', message: 'Authentication successful!' });
    } catch (error: any) {
      setIsAuthenticated(false);
      setToken('');
      
      let errorMessage = 'Authentication failed. ';
      if (error.status === 401) {
        errorMessage += 'Invalid token.';
      } else if (error.status === 403) {
        errorMessage += 'Token requires "repo" scope for full repository access.';
      } else if (error.message) {
        errorMessage += error.message;
      } else {
        errorMessage += 'Please ensure your token has the correct permissions.';
      }
      
      setUploadState({
        status: 'error',
        message: errorMessage
      });
    }
  };

  const handleCreatePR = async () => {
    if (!integrationPlan || !selectedRepo || !token) return;

    setIsPRCreating(true);
    try {
      const [owner, repo] = selectedRepo.split('/');
      const { url } = await createPullRequest({
        owner,
        repo,
        title: integrationPlan.title,
        description: integrationPlan.description,
        files: integrationPlan.files,
        token
      });

      setPrUrl(url);
      setUploadState({
        status: 'success',
        message: 'Pull request created successfully!'
      });
    } catch (error: any) {
      let errorMessage = 'Failed to create pull request. ';
      if (error.status === 403) {
        errorMessage += 'Please ensure your token has full repository access (repo scope).';
      } else if (error.message) {
        errorMessage += error.message;
      }
      
      setUploadState({
        status: 'error',
        message: errorMessage
      });
    } finally {
      setIsPRCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-800 text-white">
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h1 className="text-4xl font-bold mb-4">ProtoJam</h1>
            <p className="text-gray-400">
              Seamlessly integrate AI-generated prototypes into your production codebase
            </p>
          </div>

          {!showPRPreview ? (
            <div className="bg-gray-800 rounded-lg p-8 shadow-xl">
              <div className="space-y-6">
                {!isAuthenticated ? (
                  <div className="space-y-4">
                    <h2 className="text-xl font-semibold">GitHub Authentication</h2>
                    <p className="text-sm text-gray-400">
                      Please provide a GitHub personal access token with the following required permissions:
                    </p>
                    <div className="p-4 bg-gray-700/50 rounded-lg">
                      <h3 className="text-sm font-medium mb-2 flex items-center">
                        <AlertCircle className="h-4 w-4 mr-2 text-amber-400" />
                        Required Permissions:
                      </h3>
                      <ul className="list-disc list-inside text-sm text-gray-300 space-y-1">
                        <li><span className="font-mono">repo</span> - Full control of private repositories</li>
                        <li className="ml-6">Includes: repository contents, pull requests, and branches</li>
                      </ul>
                      <p className="mt-4 text-sm text-gray-400">
                        Create a new token with these permissions in your{' '}
                        <a
                          href="https://github.com/settings/tokens/new?scopes=repo&description=ProtoJam%20Integration"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300"
                        >
                          GitHub Settings
                        </a>
                      </p>
                    </div>
                    <form onSubmit={handleTokenSubmit} className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium mb-2">
                          Personal Access Token
                        </label>
                        <div className="flex items-center space-x-2">
                          <input
                            type="password"
                            value={token}
                            onChange={(e) => setToken(e.target.value)}
                            placeholder="ghp_************************************"
                            className="flex-1 px-4 py-2 rounded bg-gray-700 border border-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                          />
                          <Lock className="h-5 w-5 text-gray-400" />
                        </div>
                      </div>
                      <button
                        type="submit"
                        className="w-full py-2 px-4 rounded-lg font-medium bg-blue-500 hover:bg-blue-600 transition-colors"
                      >
                        Authenticate
                      </button>
                    </form>
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-2">
                        Prototype Source
                      </label>
                      <div {...getRootProps()} className={`
                        border-2 border-dashed rounded-lg p-6 text-center cursor-pointer
                        transition-colors duration-200
                        ${isDragActive ? 'border-blue-500 bg-blue-500/10' : 'border-gray-600 hover:border-gray-500'}
                      `}>
                        <input {...getInputProps()} />
                        <Upload className="mx-auto h-12 w-12 text-gray-400 mb-4" />
                        <p className="text-gray-400">
                          {isDragActive
                            ? "Drop your prototype files here"
                            : "Drag & drop your prototype files, or click to browse"}
                        </p>
                      </div>
                      <div className="mt-4">
                        <p className="text-sm text-gray-400 mb-2">Or provide a URL to your prototype:</p>
                        <input
                          type="text"
                          value={prototypeUrl}
                          onChange={(e) => setPrototypeUrl(e.target.value)}
                          placeholder="https://github.com/your-prototype"
                          className="w-full px-4 py-2 rounded bg-gray-700 border border-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-2">
                        Target Repository
                      </label>
                      <div className="relative">
                        <button
                          onClick={() => setShowRepoDropdown(!showRepoDropdown)}
                          className="w-full px-4 py-2 rounded bg-gray-700 border border-gray-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 flex items-center justify-between"
                        >
                          <div className="flex items-center space-x-2">
                            <Github className="h-5 w-5 text-gray-400" />
                            <span className="text-gray-300">
                              {selectedRepo || 'Select a repository'}
                            </span>
                          </div>
                          <ChevronDown className="h-4 w-4 text-gray-400" />
                        </button>
                        
                        {showRepoDropdown && (
                          <div className="absolute w-full mt-2 bg-gray-700 border border-gray-600 rounded-lg shadow-xl z-10 max-h-64 overflow-y-auto">
                            {repositories.map((repo) => (
                              <button
                                key={repo.full_name}
                                onClick={() => {
                                  setSelectedRepo(repo.full_name);
                                  setShowRepoDropdown(false);
                                }}
                                className="w-full px-4 py-3 text-left hover:bg-gray-600 flex items-center justify-between"
                              >
                                <div>
                                  <div className="font-medium text-gray-200">{repo.full_name}</div>
                                  {repo.description && (
                                    <div className="text-sm text-gray-400 truncate">{repo.description}</div>
                                  )}
                                </div>
                                {repo.private && (
                                  <Lock className="h-4 w-4 text-gray-400" />
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={handleSubmit}
                      disabled={!selectedRepo || uploadState.status === 'processing' || uploadState.status === 'uploading' || !llmRequest}
                      className={`
                        w-full py-3 px-4 rounded-lg font-medium flex items-center justify-center space-x-2
                        ${(!selectedRepo || uploadState.status === 'processing' || uploadState.status === 'uploading' || !llmRequest)
                          ? 'bg-blue-600/50 cursor-not-allowed'
                          : 'bg-blue-500 hover:bg-blue-600 transition-colors'}
                      `}
                    >
                      {uploadState.status === 'processing' || uploadState.status === 'uploading' ? (
                        <>
                          <Loader2 className="h-5 w-5 animate-spin" />
                          <span>{uploadState.status === 'uploading' ? 'Uploading...' : 'Analyzing...'}</span>
                        </>
                      ) : (
                        <>
                          <GitPullRequest className="h-5 w-5" />
                          <span>Analyze Integration</span>
                        </>
                      )}
                    </button>

                    {uploadState.status === 'success' && (
                      <div className="mt-4 p-4 bg-green-500/20 border border-green-500/30 rounded-lg text-green-400">
                        {uploadState.message}
                      </div>
                    )}

                    {uploadState.status === 'error' && (
                      <div className="mt-4 p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400">
                        {uploadState.message}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-gray-800 rounded-lg p-8 shadow-xl">
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-semibold mb-2">{integrationPlan?.title}</h2>
                  <div className="prose prose-invert">
                    <pre className="whitespace-pre-wrap font-sans text-sm text-gray-300">
                      {integrationPlan?.description}
                    </pre>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="border-t border-gray-700 pt-6">
                    <h3 className="text-lg font-semibold mb-4">Repository Structure</h3>
                    <div className="bg-gray-900 rounded-lg p-4 max-h-[600px] overflow-y-auto">
                      {repoTree.map((node, index) => (
                        <DirectoryTree 
                          key={node.path} 
                          node={node}
                          defaultExpanded={node.isTarget}
                        />
                      ))}
                    </div>
                    <p className="mt-4 text-sm text-gray-400">
                      <span className="inline-block w-3 h-3 bg-blue-500/20 rounded-sm mr-2" />
                      Highlighted directories indicate where new files will be placed
                    </p>
                  </div>

                  <div className="border-t border-gray-700 pt-6">
                    <h3 className="text-lg font-semibold mb-4">Proposed Changes</h3>
                    <div className="space-y-4 max-h-[600px] overflow-y-auto">
                      {integrationPlan?.files.map((file) => (
                        <FileChangePreview key={file.path} file={file} />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex justify-between">
                  <button
                    onClick={() => setShowPRPreview(false)}
                    className="px-4 py-2 rounded-lg font-medium text-gray-400 hover:text-white transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleCreatePR}
                    disabled={isPRCreating}
                    className={`
                      px-6 py-2 rounded-lg font-medium bg-blue-500 hover:bg-blue-600 
                      transition-colors flex items-center space-x-2
                      ${isPRCreating ? 'opacity-75 cursor-not-allowed' : ''}
                    `}
                  >
                    {isPRCreating ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span>Creating PR...</span>
                      </>
                    ) : (
                      <>
                        <GitPullRequest className="h-5 w-5" />
                        <span>Create Pull Request</span>
                      </>
                    )}
                  </button>
                </div>

                {prUrl && (
                  <div className="mt-4 p-4 bg-green-500/20 border border-green-500/30 rounded-lg">
                    <p className="text-green-400">
                      Pull request created successfully!{' '}
                      <a
                        href={prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 underline"
                      >
                        View PR
                      </a>
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="mt-8 text-center text-sm text-gray-400">
            <p>Currently supports NextJS + Tailwind prototypes</p>
            <div className="flex items-center justify-center mt-2 space-x-2">
              <Code2 className="h-4 w-4" />
              <span>Automated code analysis and PR generation</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
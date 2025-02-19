import { Octokit } from '@octokit/rest';
import { Buffer } from 'buffer';

interface CreatePullRequestParams {
  owner: string;
  repo: string;
  title: string;
  description: string;
  files: Array<{
    path: string;
    content: string;
  }>;
  baseBranch?: string;
  token: string;
}

export async function createPullRequest({
  owner,
  repo,
  title,
  description,
  files,
  baseBranch = 'main',
  token
}: CreatePullRequestParams) {
  const octokit = new Octokit({ auth: token });

  try {
    // Validate repository access
    try {
      await octokit.repos.get({ owner, repo });
    } catch (error: any) {
      if (error.status === 404) {
        throw new Error(`Repository ${owner}/${repo} not found or inaccessible`);
      }
      throw error;
    }

    // 1. Get the default branch's latest commit SHA
    let ref;
    try {
      const response = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${baseBranch}`
      });
      ref = response.data;
    } catch (error: any) {
      if (error.status === 404) {
        throw new Error(`Branch '${baseBranch}' not found. Please verify the base branch name.`);
      }
      throw error;
    }
    const baseSha = ref.object.sha;

    // 2. Create a new branch
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const branchName = `feature/prototype-integration-${timestamp}`;
    
    try {
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: baseSha
      });
    } catch (error: any) {
      if (error.status === 422) {
        throw new Error('Failed to create branch. The branch may already exist.');
      }
      throw error;
    }

    // 3. Create/update files in the new branch
    for (const file of files) {
      if (!file.path || !file.content) {
        console.warn(`Skipping invalid file: ${file.path}`);
        continue;
      }

      try {
        // Try to get existing file first
        const { data: existingFile } = await octokit.repos.getContent({
          owner,
          repo,
          path: file.path,
          ref: branchName
        });

        if ('content' in existingFile) {
          // Update existing file
          await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: file.path,
            message: `Update ${file.path} for prototype integration`,
            content: Buffer.from(file.content).toString('base64'),
            sha: existingFile.sha,
            branch: branchName
          });
        }
      } catch (error: any) {
        if (error.status === 404) {
          // File doesn't exist, create it
          try {
            await octokit.repos.createOrUpdateFileContents({
              owner,
              repo,
              path: file.path,
              message: `Add ${file.path} for prototype integration`,
              content: Buffer.from(file.content).toString('base64'),
              branch: branchName
            });
          } catch (createError: any) {
            if (createError.status === 422) {
              throw new Error(`Failed to create file ${file.path}. The file may be invalid or too large.`);
            }
            throw createError;
          }
        } else {
          throw error;
        }
      }
    }

    // 4. Create pull request
    try {
      const { data: pullRequest } = await octokit.pulls.create({
        owner,
        repo,
        title,
        body: description,
        head: branchName,
        base: baseBranch
      });

      return {
        url: pullRequest.html_url,
        number: pullRequest.number,
        branch: branchName
      };
    } catch (error: any) {
      if (error.status === 422) {
        throw new Error('Failed to create pull request. A PR might already exist for this branch.');
      }
      throw error;
    }
  } catch (error: any) {
    console.error('Error creating pull request:', error);
    
    // Enhance error message based on status codes
    let errorMessage = 'Failed to create pull request. ';
    if (error.status === 401) {
      errorMessage += 'Invalid authentication token.';
    } else if (error.status === 403) {
      errorMessage += 'Insufficient permissions. Please ensure your token has the "repo" scope.';
    } else if (error.status === 404) {
      errorMessage += 'Repository not found or inaccessible.';
    } else if (error.status === 422) {
      errorMessage += 'Invalid request. Please check your inputs.';
    } else if (error.message) {
      errorMessage += error.message;
    }

    throw new Error(errorMessage);
  }
}
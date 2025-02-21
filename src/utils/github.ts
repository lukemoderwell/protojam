import { Octokit } from '@octokit/rest';
import type { IntegrationPlan, PullRequestPlan } from './llm';

interface CreatePullRequestParams {
  owner: string;
  repo: string;
  plan: IntegrationPlan;
  baseBranch: string;
  token: string;
}

interface PullRequestResult {
  url: string;
  number: number;
  branch: string;
}

class GitHubError extends Error {
  constructor(
    message: string,
    public status?: number,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export class GitHubService {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  private async validateRepository(owner: string, repo: string): Promise<void> {
    try {
      await this.octokit.repos.get({ owner, repo });
    } catch (error: any) {
      if (error?.status === 404) {
        throw new GitHubError(
          `Repository ${owner}/${repo} not found or inaccessible`,
          404,
          error
        );
      }
      throw new GitHubError(
        'Failed to validate repository access',
        error?.status,
        error
      );
    }
  }

  private async getBaseBranch(owner: string, repo: string, branch: string) {
    try {
      const { data: ref } = await this.octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });

      const { data: commit } = await this.octokit.git.getCommit({
        owner,
        repo,
        commit_sha: ref.object.sha,
      });

      return {
        sha: ref.object.sha,
        treeSha: commit.tree.sha,
      };
    } catch (error: any) {
      if (error?.status === 404) {
        throw new GitHubError(
          `Branch '${branch}' not found. Please verify the base branch name.`,
          404,
          error
        );
      }
      throw new GitHubError(
        'Failed to get base branch information',
        error?.status,
        error
      );
    }
  }

  private generateBranchName(plan: IntegrationPlan): string {
    const safePrototypeName = (plan.pullRequest.route || 'prototype')
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-');
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('Z', '');
    return `protojam-${safePrototypeName}-${timestamp}`;
  }

  private async createGitTree(
    owner: string,
    repo: string,
    baseTreeSha: string,
    files: PullRequestPlan['files']
  ) {
    try {
      const treeEntries = files
        .filter((file) => file.path && file.content)
        .map((file) => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          content: file.content,
        }));

      if (!treeEntries.length) {
        throw new GitHubError(
          'No valid files to commit. Each file must have both path and content.',
          422
        );
      }

      const { data: tree } = await this.octokit.git.createTree({
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: treeEntries,
      });
      return tree;
    } catch (error: any) {
      if (error instanceof GitHubError) {
        throw error;
      }
      console.error('Tree creation payload:', {
        baseTreeSha,
        fileCount: files.length,
        validFileCount: files.filter((f) => f.path && f.content).length,
      });
      throw new GitHubError(
        `Failed to create Git tree: ${error.message || 'Unknown error'}`,
        error?.status,
        error
      );
    }
  }

  private async createCommit(
    owner: string,
    repo: string,
    message: string,
    treeSha: string,
    parentSha: string
  ) {
    try {
      const { data: commit } = await this.octokit.git.createCommit({
        owner,
        repo,
        message,
        tree: treeSha,
        parents: [parentSha],
      });
      return commit;
    } catch (error: any) {
      throw new GitHubError('Failed to create commit', error?.status, error);
    }
  }

  private async createOrUpdateBranch(
    owner: string,
    repo: string,
    branchName: string,
    commitSha: string
  ) {
    try {
      await this.octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: commitSha,
      });
    } catch (error: any) {
      if (error?.status === 422) {
        await this.octokit.git.updateRef({
          owner,
          repo,
          ref: `heads/${branchName}`,
          sha: commitSha,
          force: true,
        });
      } else {
        throw new GitHubError(
          'Failed to create or update branch',
          error?.status,
          error
        );
      }
    }
  }

  private async createPR(
    owner: string,
    repo: string,
    plan: IntegrationPlan,
    branchName: string,
    baseBranch: string
  ) {
    try {
      const { data: pullRequest } = await this.octokit.pulls.create({
        owner,
        repo,
        title: `[ProtoJam] ${plan.pullRequest.title}`,
        body: this.formatPRDescription(plan),
        head: branchName,
        base: baseBranch,
      });
      return pullRequest;
    } catch (error: any) {
      if (error?.status === 422) {
        throw new GitHubError(
          'Failed to create pull request. A PR might already exist for this branch.',
          422,
          error
        );
      }
      throw new GitHubError(
        'Failed to create pull request',
        error?.status,
        error
      );
    }
  }

  private formatPRDescription(plan: IntegrationPlan): string {
    const sections = [
      plan.pullRequest.description,
      '## Integration Details',
      plan.pullRequest.route ? `- Route: \`${plan.pullRequest.route}\`` : null,
      `- Files Modified: ${plan.pullRequest.files.length}`,
      '',
      '## Changes Overview',
      ...plan.integrationSteps.map((step) => `### ${step}`),
    ];

    return sections.filter(Boolean).join('\n\n');
  }

  public async createPullRequest({
    owner,
    repo,
    plan,
    baseBranch,
  }: CreatePullRequestParams): Promise<PullRequestResult> {
    try {
      if (!plan.pullRequest.files?.length) {
        throw new GitHubError(
          'Pull request plan must contain at least one file',
          422
        );
      }

      // Validate repository access
      await this.validateRepository(owner, repo);

      // Get base branch information
      const { sha: baseSha, treeSha: baseTreeSha } = await this.getBaseBranch(
        owner,
        repo,
        baseBranch
      );

      // Generate branch name
      const branchName = this.generateBranchName(plan);

      // Create tree with changes
      const tree = await this.createGitTree(
        owner,
        repo,
        baseTreeSha,
        plan.pullRequest.files
      );

      // Create commit
      const commit = await this.createCommit(
        owner,
        repo,
        plan.pullRequest.title,
        tree.sha,
        baseSha
      );

      // Create or update branch
      await this.createOrUpdateBranch(owner, repo, branchName, commit.sha);

      // Create pull request
      const pullRequest = await this.createPR(
        owner,
        repo,
        plan,
        branchName,
        baseBranch
      );

      return {
        url: pullRequest.html_url,
        number: pullRequest.number,
        branch: branchName,
      };
    } catch (error) {
      if (error instanceof GitHubError) {
        throw error;
      }
      throw new GitHubError(
        'An unexpected error occurred while creating the pull request',
        undefined,
        error
      );
    }
  }
}

export async function createPullRequest(
  params: CreatePullRequestParams
): Promise<PullRequestResult> {
  const service = new GitHubService(params.token);
  return service.createPullRequest(params);
}

import type { GitlabProjectApi } from '@cpn-console/gitlab-plugin/types/class.js'
import type { Environment, PluginResult, Project, StepCall, UserObject } from '@cpn-console/hooks'
import type { KeycloakProjectApi } from '@cpn-console/keycloak-plugin/types/class.js'
import { okStatus, parseError, specificallyDisabled } from '@cpn-console/hooks'
import { logger as baseLogger } from '@cpn-console/logger'
import { compressUUID } from '@cpn-console/shared'
import {
  deleteKeycloakGroup,
  ensureKeycloakGroups,
  generateGrafanaHprodRbacGroupPaths,
  generateGrafanaProdRbacGroupPaths,
} from './keycloak.js'
import { type EnvType, type ObservabilityProject, ObservabilityRepoManager, observabilityRepository } from './observability-repo-manager.js'

const logger = baseLogger.child({ plugin: 'observability' })

const okSkipped: PluginResult = {
  status: {
    result: 'OK',
    message: 'Plugin disabled',
  },
}

export type ListPerms = Record<'prod' | 'hors-prod', Record<'view' | 'edit', UserObject['id'][]>>

function getListPerms(environments: Environment[]): ListPerms {
  const allProdPerms = environments
    .filter(env => env.stage === 'prod')
    .map(env => env.permissions)
    .flat()
  const allHProdPerms = environments
    .filter(env => env.stage !== 'prod')
    .map(env => env.permissions)
    .flat()

  const listPerms: ListPerms = {
    'hors-prod': {
      edit: [],
      view: [],
    },
    prod: {
      edit: [],
      view: [],
    },
  }
  for (const permission of allProdPerms) {
    if (permission.permissions.rw && !listPerms.prod.edit.includes(permission.userId)) {
      listPerms.prod.edit.push(permission.userId)
    }
    if (permission.permissions.ro && !listPerms.prod.view.includes(permission.userId)) {
      listPerms.prod.view.push(permission.userId)
    }
  }
  for (const permission of allHProdPerms) {
    if (permission.permissions.rw && !listPerms['hors-prod'].edit.includes(permission.userId)) {
      listPerms['hors-prod'].edit.push(permission.userId)
    }
    if (permission.permissions.ro && !listPerms['hors-prod'].view.includes(permission.userId)) {
      listPerms['hors-prod'].view.push(permission.userId)
    }
  }
  return listPerms
}

// Create and update (if needed) the project repository for custom dashboards and alerts
export const ensureProjectRepository: StepCall<Project> = async (payload) => {
  const gitlabProjectApi = payload.apis.gitlab as GitlabProjectApi
  try {
    logger.info({ action: 'ensureProjectRepository', repository: observabilityRepository }, 'Hook start')
    await gitlabProjectApi.getProjectId(observabilityRepository)
  } catch (e) {
    logger.warn({ action: 'ensureProjectRepository', repository: observabilityRepository, err: e }, 'Repository not found, creating')
    await gitlabProjectApi.createEmptyProjectRepository({
      repoName: observabilityRepository,
      description: 'Respository for custom Observability infrastructure resources',
      clone: false,
    })
  }
  // Reference to avoid deletion
  gitlabProjectApi.addSpecialRepositories(observabilityRepository)
  logger.info({ action: 'ensureProjectRepository', repository: observabilityRepository }, 'Hook done')
  return okStatus
}

export const upsertProject: StepCall<Project> = async (payload) => {
  try {
    if (specificallyDisabled(payload.config.observability?.enabled)) {
      logger.info({ action: 'upsertProject', projectId: payload.args.id, projectSlug: payload.args.slug }, 'Hook skipped')
      return okSkipped
    }
    const project = payload.args
    const keycloakApi = payload.apis.keycloak as KeycloakProjectApi
    const gitlabApi = payload.apis.gitlab as GitlabProjectApi

    logger.info({ action: 'upsertProject', projectId: project.id, projectSlug: project.slug }, 'Hook start')

    const keycloakRootGroupPath = await keycloakApi.getProjectGroupPath()
    const tenantRbacProd = generateGrafanaProdRbacGroupPaths(keycloakRootGroupPath)
    const tenantRbacHProd = generateGrafanaHprodRbacGroupPaths(keycloakRootGroupPath)

    const tenantId = compressUUID(project.id)

    const projectValue: ObservabilityProject = {
      projectName: project.slug,
      projectRepository: {
        url: await gitlabApi.getPublicRepoUrl(observabilityRepository),
        path: '.',
      },
      envs: {
        hprod: {
          groups: tenantRbacHProd,
          tenants: {},
        },
        prod: {
          groups: tenantRbacProd,
          tenants: {},
        },
      },
    }

    for (const environment of payload.args.environments) {
      const env: EnvType = environment.stage === 'prod' ? 'prod' : 'hprod'
      projectValue.envs[env].tenants[`${env}-${tenantId}`] = {}
    }

    if (projectValue.envs.hprod && !Object.values(projectValue.envs.hprod.tenants).length) {
      // @ts-ignore
      delete projectValue.envs.hprod
    }
    if (projectValue.envs.prod && !Object.values(projectValue.envs.prod?.tenants).length) {
      // @ts-ignore
      delete projectValue.envs.prod
    }

    const listPerms = getListPerms(project.environments)
    logger.debug({
      action: 'upsertProject',
      projectId: project.id,
      projectSlug: project.slug,
      envs: Object.keys(projectValue.envs),
      perms: {
        prod: { edit: listPerms.prod.edit.length, view: listPerms.prod.view.length },
        hprod: { edit: listPerms['hors-prod'].edit.length, view: listPerms['hors-prod'].view.length },
      },
    }, 'Computed observability config')

    // Upsert or delete Gitlab config based on prod/non-prod environment
    const observabilityRepoManager = new ObservabilityRepoManager(gitlabApi)
    const yamlResult = await observabilityRepoManager.updateProjectConfig(project, projectValue)
    logger.info({ action: 'upsertProject', projectId: project.id, projectSlug: project.slug, result: yamlResult }, 'Gitlab config synced')

    await ensureKeycloakGroups(listPerms, keycloakApi)
    logger.info({ action: 'upsertProject', projectId: project.id, projectSlug: project.slug }, 'Keycloak groups synced')

    return {
      status: {
        result: 'OK',
        message: yamlResult,
      },
      store: {
        instances: Object.keys(projectValue.envs).join(','),
      },
    }
  } catch (error) {
    logger.error({ action: 'upsertProject', projectId: payload.args.id, projectSlug: payload.args.slug, err: error }, 'Hook failed')
    return {
      status: {
        result: 'KO',
        message: 'An error happened while creating Observability resources',
      },
      error: parseError(error),
    }
  }
}

export const deleteProject: StepCall<Project> = async (payload) => {
  try {
    if (specificallyDisabled(payload.config.observability?.enabled)) {
      logger.info({ action: 'deleteProject', projectId: payload.args.id, projectSlug: payload.args.slug }, 'Hook skipped')
      return okSkipped
    }
    const project = payload.args
    const keycloakApi = payload.apis.keycloak as KeycloakProjectApi
    const observabilityRepoManager = new ObservabilityRepoManager(payload.apis.gitlab)

    logger.info({ action: 'deleteProject', projectId: project.id, projectSlug: project.slug }, 'Hook start')
    await Promise.all([
      deleteKeycloakGroup(keycloakApi),
      observabilityRepoManager.deleteProjectConfig(project),
    ])

    logger.info({ action: 'deleteProject', projectId: project.id, projectSlug: project.slug }, 'Hook done')
    return {
      status: {
        result: 'OK',
        message: 'Deleted',
      },
    }
  } catch (error) {
    logger.error({ action: 'deleteProject', projectId: payload.args.id, projectSlug: payload.args.slug, err: error }, 'Hook failed')
    return {
      status: {
        result: 'OK',
        message: 'An error happened while deleting resources',
      },
      error: JSON.stringify(error),
    }
  }
}

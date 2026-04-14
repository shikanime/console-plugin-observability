import type { KeycloakProjectApi } from '@cpn-console/keycloak-plugin/types/class.js'
import type KeycloakAdminClient from '@keycloak/keycloak-admin-client'
import type GroupRepresentation from '@keycloak/keycloak-admin-client/lib/defs/groupRepresentation.js'
import type UserRepresentation from '@keycloak/keycloak-admin-client/lib/defs/userRepresentation.js'
import type { ListPerms } from './function.js'
import { logger as baseLogger } from '@cpn-console/logger'
import KcAdminClient from '@keycloak/keycloak-admin-client'
import { getConfig } from './utils.js'

const logger = baseLogger.child({ plugin: 'observability', module: 'keycloak' })

export const GRAFANA_GROUP_NAME = 'grafana' as const

export const GRAFANA_SUBGROUP_HPROD_RW = 'hprod-RW' as const
export const GRAFANA_SUBGROUP_HPROD_RO = 'hprod-RO' as const
export const GRAFANA_SUBGROUP_PROD_RW = 'prod-RW' as const
export const GRAFANA_SUBGROUP_PROD_RO = 'prod-RO' as const

type GrafanaSubGroupName =
  | typeof GRAFANA_SUBGROUP_HPROD_RW
  | typeof GRAFANA_SUBGROUP_HPROD_RO
  | typeof GRAFANA_SUBGROUP_PROD_RW
  | typeof GRAFANA_SUBGROUP_PROD_RO

export function generateGrafanaGroupPath(keycloakRootGroupPath: string, subGroupName: GrafanaSubGroupName): string {
  const normalizedRoot = keycloakRootGroupPath.endsWith('/')
    ? keycloakRootGroupPath.slice(0, -1)
    : keycloakRootGroupPath
  return `${normalizedRoot}/${GRAFANA_GROUP_NAME}/${subGroupName}`
}

export function generateGrafanaProdRbacGroupPaths(keycloakRootGroupPath: string): [string, string] {
  return [
    generateGrafanaGroupPath(keycloakRootGroupPath, GRAFANA_SUBGROUP_PROD_RW),
    generateGrafanaGroupPath(keycloakRootGroupPath, GRAFANA_SUBGROUP_PROD_RO),
  ]
}

export function generateGrafanaHprodRbacGroupPaths(keycloakRootGroupPath: string): [string, string] {
  return [
    generateGrafanaGroupPath(keycloakRootGroupPath, GRAFANA_SUBGROUP_HPROD_RW),
    generateGrafanaGroupPath(keycloakRootGroupPath, GRAFANA_SUBGROUP_HPROD_RO),
  ]
}

export async function getkcClient() {
  const kcClient = new KcAdminClient({
    baseUrl: `${getConfig().keycloakProtocol}://${getConfig().keycloakDomain}`,
  })

  await kcClient.auth({
    clientId: 'admin-cli',
    grantType: 'password',
    username: getConfig().keycloakUser,
    password: getConfig().keycloakToken,
  })
  kcClient.setConfig({ realmName: getConfig().keycloakRealm })
  return kcClient
}

async function getRootGroupProject(keycloakApi: KeycloakProjectApi): Promise<Required<GroupRepresentation> | undefined> {
  const kcClient = await getkcClient()
  const rootGroupPath = await keycloakApi.getProjectGroupPath()
  const groups = await kcClient.groups.find({ search: rootGroupPath.slice(1), exact: true })
  return groups.find(g => g.path === rootGroupPath) as Required<GroupRepresentation> | undefined
}

export async function ensureKeycloakGroups(listPerms: ListPerms, keycloakApi: KeycloakProjectApi) {
  const kcClient = await getkcClient()
  const rootGroup = await getRootGroupProject(keycloakApi)
  const rootGroupPath = await keycloakApi.getProjectGroupPath()
  if (!rootGroup) throw new Error(`Unable to find root keycloak group ${rootGroupPath}`)

  logger.debug({
    action: 'ensureKeycloakGroups',
    rootGroupPath,
    desired: {
      hprod: { edit: listPerms['hors-prod'].edit.length, view: listPerms['hors-prod'].view.length },
      prod: { edit: listPerms.prod.edit.length, view: listPerms.prod.view.length },
    },
  }, 'Starting Keycloak group sync')

  const subgroupsMetrics = await findOrCreateMetricGroupAndSubGroups(rootGroup.id)
  const promises: Promise<any>[] = []
  let additions = 0
  let removals = 0

  // à ajouter
  listPerms['hors-prod'].edit.forEach((userId) => {
    if (subgroupsMetrics[GRAFANA_SUBGROUP_HPROD_RW].members.find(member => member.id === userId)) return
    additions += 1
    promises.push(kcClient.users.addToGroup({ groupId: subgroupsMetrics[GRAFANA_SUBGROUP_HPROD_RW].id, id: userId }))
  })
  listPerms['hors-prod'].view.forEach((userId) => {
    if (subgroupsMetrics[GRAFANA_SUBGROUP_HPROD_RO].members.find(member => member.id === userId)) return
    additions += 1
    promises.push(kcClient.users.addToGroup({ groupId: subgroupsMetrics[GRAFANA_SUBGROUP_HPROD_RO].id, id: userId }))
  })
  listPerms.prod.edit.forEach((userId) => {
    if (subgroupsMetrics[GRAFANA_SUBGROUP_PROD_RW].members.find(member => member.id === userId)) return
    additions += 1
    promises.push(kcClient.users.addToGroup({ groupId: subgroupsMetrics[GRAFANA_SUBGROUP_PROD_RW].id, id: userId }))
  })
  listPerms.prod.view.forEach((userId) => {
    if (subgroupsMetrics[GRAFANA_SUBGROUP_PROD_RO].members.find(member => member.id === userId)) return
    additions += 1
    promises.push(kcClient.users.addToGroup({ groupId: subgroupsMetrics[GRAFANA_SUBGROUP_PROD_RO].id, id: userId }))
  })

  // à retirer
  subgroupsMetrics[GRAFANA_SUBGROUP_HPROD_RW].members.forEach((member) => {
    if (listPerms['hors-prod'].edit.includes(member.id)) return
    removals += 1
    promises.push(kcClient.users.delFromGroup({ id: member.id, groupId: subgroupsMetrics[GRAFANA_SUBGROUP_HPROD_RW].id }))
  })
  subgroupsMetrics[GRAFANA_SUBGROUP_HPROD_RO].members.forEach((member) => {
    if (listPerms['hors-prod'].view.includes(member.id)) return
    removals += 1
    promises.push(kcClient.users.delFromGroup({ id: member.id, groupId: subgroupsMetrics[GRAFANA_SUBGROUP_HPROD_RO].id }))
  })
  subgroupsMetrics[GRAFANA_SUBGROUP_PROD_RW].members.forEach((member) => {
    if (listPerms.prod.edit.includes(member.id)) return
    removals += 1
    promises.push(kcClient.users.delFromGroup({ id: member.id, groupId: subgroupsMetrics[GRAFANA_SUBGROUP_PROD_RW].id }))
  })
  subgroupsMetrics[GRAFANA_SUBGROUP_PROD_RO].members.forEach((member) => {
    if (listPerms.prod.view.includes(member.id)) return
    removals += 1
    promises.push(kcClient.users.delFromGroup({ id: member.id, groupId: subgroupsMetrics[GRAFANA_SUBGROUP_PROD_RO].id }))
  })

  logger.info({
    action: 'ensureKeycloakGroups',
    rootGroupPath,
    groups: {
      hprodRw: subgroupsMetrics[GRAFANA_SUBGROUP_HPROD_RW].path,
      hprodRo: subgroupsMetrics[GRAFANA_SUBGROUP_HPROD_RO].path,
      prodRw: subgroupsMetrics[GRAFANA_SUBGROUP_PROD_RW].path,
      prodRo: subgroupsMetrics[GRAFANA_SUBGROUP_PROD_RO].path,
    },
    changes: { additions, removals, total: additions + removals },
  }, 'Syncing Keycloak group membership')

  const results = await Promise.all(promises)
  logger.info({ action: 'ensureKeycloakGroups', rootGroupPath, changes: { additions, removals, total: additions + removals } }, 'Keycloak group sync done')
  return results
}

type GroupDetails = Required<GroupRepresentation> & { members: Required<UserRepresentation>[] }

type SubgroupsMetrics = Record<GrafanaSubGroupName, GroupDetails>

async function findMetricsGroup(kcClient: KeycloakAdminClient, parentId: string) {
  const groups = await kcClient.groups.listSubGroups({ parentId })
  return groups.find(g => g.name === GRAFANA_GROUP_NAME) as Required<GroupRepresentation> | undefined
}

async function findOrCreateMetricGroupAndSubGroups(parentId: string): Promise<SubgroupsMetrics> {
  const kcClient = await getkcClient()
  const testMetricsGroup = await findMetricsGroup(kcClient, parentId)
  if (!testMetricsGroup) {
    const metricsGroup = await kcClient.groups.createChildGroup({ id: parentId }, { name: GRAFANA_GROUP_NAME })
    return {
      [GRAFANA_SUBGROUP_HPROD_RW]: await createKeycloakGrafanaSubGroup(GRAFANA_SUBGROUP_HPROD_RW, metricsGroup.id, kcClient),
      [GRAFANA_SUBGROUP_HPROD_RO]: await createKeycloakGrafanaSubGroup(GRAFANA_SUBGROUP_HPROD_RO, metricsGroup.id, kcClient),
      [GRAFANA_SUBGROUP_PROD_RW]: await createKeycloakGrafanaSubGroup(GRAFANA_SUBGROUP_PROD_RW, metricsGroup.id, kcClient),
      [GRAFANA_SUBGROUP_PROD_RO]: await createKeycloakGrafanaSubGroup(GRAFANA_SUBGROUP_PROD_RO, metricsGroup.id, kcClient),
    }
  }
  const metricsSubGroups = await kcClient.groups.listSubGroups({ parentId: testMetricsGroup.id }) as Required<GroupRepresentation>[]
  const grafanaHorsProdEdit = metricsSubGroups.find(g => g.name === GRAFANA_SUBGROUP_HPROD_RW)
  const grafanaHorsProdView = metricsSubGroups.find(g => g.name === GRAFANA_SUBGROUP_HPROD_RO)
  const grafanaProdEdit = metricsSubGroups.find(g => g.name === GRAFANA_SUBGROUP_PROD_RW)
  const grafanaProdView = metricsSubGroups.find(g => g.name === GRAFANA_SUBGROUP_PROD_RO)
  return {
    [GRAFANA_SUBGROUP_HPROD_RW]: grafanaHorsProdEdit
      ? await findDetails(grafanaHorsProdEdit, kcClient)
      : await createKeycloakGrafanaSubGroup(GRAFANA_SUBGROUP_HPROD_RW, testMetricsGroup.id, kcClient),
    [GRAFANA_SUBGROUP_HPROD_RO]: grafanaHorsProdView
      ? await findDetails(grafanaHorsProdView, kcClient)
      : await createKeycloakGrafanaSubGroup(GRAFANA_SUBGROUP_HPROD_RO, testMetricsGroup.id, kcClient),
    [GRAFANA_SUBGROUP_PROD_RW]: grafanaProdEdit
      ? await findDetails(grafanaProdEdit, kcClient)
      : await createKeycloakGrafanaSubGroup(GRAFANA_SUBGROUP_PROD_RW, testMetricsGroup.id, kcClient),
    [GRAFANA_SUBGROUP_PROD_RO]: grafanaProdView
      ? await findDetails(grafanaProdView, kcClient)
      : await createKeycloakGrafanaSubGroup(GRAFANA_SUBGROUP_PROD_RO, testMetricsGroup.id, kcClient),
  }
}

async function createKeycloakGrafanaSubGroup(name: GrafanaSubGroupName, parentId: string, kcClient: KeycloakAdminClient): Promise<GroupDetails> {
  return {
    ...(await kcClient.groups.createChildGroup({ id: parentId }, { name })) as Required<GroupRepresentation>,
    members: [],
  }
}

async function findDetails(group: Required<GroupRepresentation>, kcClient: KeycloakAdminClient): Promise<GroupDetails> {
  return {
    ...group,
    members: await kcClient.groups.listMembers({ id: group.id }) as Required<UserRepresentation>[],
  }
}

export async function deleteKeycloakGroup(keycloakApi: KeycloakProjectApi) {
  const kcClient = await getkcClient()
  const projectRootGroup = await getRootGroupProject(keycloakApi)
  if (!projectRootGroup) {
    logger.info({ action: 'deleteKeycloakGroup' }, 'No project root group, nothing to delete')
    return
  }
  const testMetricsGroup = await findMetricsGroup(kcClient, projectRootGroup?.id)
  if (!testMetricsGroup) {
    logger.info({ action: 'deleteKeycloakGroup', projectGroupPath: projectRootGroup.path }, 'No grafana group, nothing to delete')
    return
  }
  logger.info({ action: 'deleteKeycloakGroup', projectGroupPath: projectRootGroup.path, groupId: testMetricsGroup.id }, 'Deleting grafana group')
  return kcClient.groups.del({ id: testMetricsGroup.id })
}

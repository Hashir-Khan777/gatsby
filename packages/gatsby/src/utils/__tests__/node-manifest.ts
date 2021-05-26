import { foundPageByToLogIds } from "./../node-manifest"
import path from "path"
import fs from "fs-extra"
import reporter from "gatsby-cli/lib/reporter"
import { store } from "../../redux"

import { INodeManifest } from "./../../redux/types"

import {
  warnAboutNodeManifestMappingProblems,
  processNodeManifests,
} from "../node-manifest"

jest.mock(`fs-extra`, () => {
  return {
    ensureDir: jest.fn(),
    writeJSON: jest.fn((manifestFilePath, finalManifest) => {
      if (process.env.DEBUG) {
        console.log({ manifestFilePath, finalManifest })
      }
      return { manifestFilePath, finalManifest }
    }),
  }
})

jest.mock(`gatsby-cli/lib/reporter`, () => {
  return {
    error: jest.fn(input => {
      if (process.env.DEBUG) {
        console.error(JSON.stringify(input, null, 2))
      }
      return input
    }),
    warn: jest.fn(message => {
      if (process.env.DEBUG) {
        console.warn(message)
      }
      return message
    }),
    info: jest.fn(message => {
      if (process.env.DEBUG) {
        console.info(message)
      }
      return message
    }),
  }
})

jest.mock(`../../redux`, () => {
  const initialState = {
    nodeManifests: [],
    nodes: new Map(),
    pages: new Map(),
    program: {
      directory: process.cwd(),
    },
    queries: { byNode: new Map() },
  }

  let state = { ...initialState }

  return {
    store: {
      getState: jest.fn(() => state),
      getNode: (nodeId: string): { id: string } | undefined =>
        state.nodes.get(nodeId),
      setManifests: (manifests): void => {
        state.nodeManifests = manifests
      },
      createNode: (node): void => {
        state.nodes.set(node.id, node)
      },
      createPage: (page): void => {
        state.pages.set(page.path, page)
      },
      trackPagePathOnNode: (nodeId: string, pagePath: string): void => {
        const byNode = state.queries.byNode || new Map()
        const pagePaths = byNode.get(nodeId)

        if (pagePaths?.size > 0) {
          pagePaths.add(pagePath)
          byNode.set(nodeId, pagePaths)
        } else {
          byNode.set(nodeId, new Set([pagePath]))
        }

        state.queries.byNode = byNode
      },
      reset: (): void => {
        state = { ...initialState }
      },
      dispatch: jest.fn(),
    },
  }
})

beforeEach(() => {
  jest.clearAllMocks()
  store.reset()
  delete process.env._GATSBY_INTERNAL_TEST_NODE_MANIFEST_AS_DEVELOP
})

describe(`processNodeManifests() warnings`, () => {
  it(`warns about no page found for manifest node id`, async () => {
    store.createNode({
      id: `1`,
    })
    store.setManifests([
      {
        pluginName: `test`,
        node: { id: `1` },
        manifestId: `1`,
      },
    ])

    await processNodeManifests()

    expect(reporter.error).toBeCalled()
    expect(reporter.error.mock.results[0].value.id).toEqual(
      foundPageByToLogIds.none
    )
  })

  it(`warns about using context.id to map from node->page instead of ownerNodeId`, async () => {
    store.createNode({
      id: `1`,
    })
    store.createNode({
      id: `2`,
    })
    store.createPage({
      path: `/test`,
      context: { id: `1` },
    })
    store.createPage({
      path: `/test-2`,
      context: { id: `2` },
    })
    store.setManifests([
      {
        pluginName: `test`,
        node: { id: `1` },
        manifestId: `1`,
      },
    ])

    // first as develop
    process.env.NODE_ENV = `development`

    await processNodeManifests()

    expect(reporter.error).toBeCalled()
    expect(reporter.error.mock.results[0].value.id).toEqual(
      foundPageByToLogIds[`context.id`]
    )

    // then as build
    process.env.NODE_ENV = `production`

    // adding both nodes to query tracking on each page to force using context.id
    store.trackPagePathOnNode(`1`, `/test`)
    store.trackPagePathOnNode(`1`, `/test-2`)
    store.trackPagePathOnNode(`2`, `/test`)
    store.trackPagePathOnNode(`2`, `/test-2`)

    await processNodeManifests()

    expect(reporter.error).toBeCalled()
    expect(reporter.error.mock.results[1].value.id).toEqual(
      foundPageByToLogIds[`context.id`]
    )
    process.env.NODE_ENV = `test`
  })

  it(`warns about using node->query tracking to map from node->page instead of using ownerNodeId`, async () => {
    store.createNode({
      id: `1`,
    })
    store.createPage({
      path: `/test`,
      context: {},
    })
    store.setManifests([
      {
        pluginName: `test`,
        node: { id: `1` },
        manifestId: `1`,
      },
    ])

    store.trackPagePathOnNode(`1`, `/test`)

    await processNodeManifests()

    expect(reporter.error).toBeCalled()
    expect(reporter.error.mock.results[0].value.id).toEqual(
      foundPageByToLogIds[`queryTracking`]
    )
  })

  it(`doesn't warn when using the filesystem route api to map nodes->pages`, () => {
    const { logId } = warnAboutNodeManifestMappingProblems({
      inputManifest: {
        pluginName: `test`,
        node: { id: `1` },
        manifestId: `1`,
      },
      pagePath: `/test`,
      foundPageBy: `filesystem-route-api`,
    })

    expect(reporter.error).not.toBeCalled()
    expect(logId).toEqual(foundPageByToLogIds[`filesystem-route-api`])
  })

  it(`warnings helper throws in impossible foundPageBy state`, () => {
    expect(() =>
      warnAboutNodeManifestMappingProblems({
        pagePath: undefined,
        // @ts-ignore: intentionally doing the wrong thing here
        inputManifest: null,
        // @ts-ignore: intentionally doing the wrong thing here
        foundPageBy: `nope`,
      })
    ).toThrow()
  })
})

describe(`processNodeManifests`, () => {
  it(`Doesn't do anything when there are no pending manifests`, async () => {
    await processNodeManifests()

    expect(fs.writeJSON).not.toBeCalled()
    expect(reporter.info).not.toBeCalled()
    expect(reporter.warn).not.toBeCalled()
    expect(reporter.error).not.toBeCalled()
    expect(store.dispatch).not.toBeCalled()
  })

  const testProcessNodeManifests = async (): Promise<void> => {
    const nodes = [
      { id: `1`, usePageContextId: true },
      { id: `2`, useOwnerNodeId: true },
      { id: `3`, useQueryTracking: true },
    ]

    nodes.forEach(node => {
      // @ts-ignore: store is mocked
      store.createNode(node)

      const pagePath = `/${node.id}`

      // @ts-ignore: store is mocked
      store.createPage({
        path: pagePath,
        ownerNodeId: node.useOwnerNodeId ? node.id : null,
        context: {
          id: node.usePageContextId ? node.id : null,
        },
      })

      if (
        node.useQueryTracking ||
        // if this isn't gatsby develop we emulate gatsby build
        // where query tracking is always 100% complete
        !process.env._GATSBY_INTERNAL_TEST_NODE_MANIFEST_AS_DEVELOP
      ) {
        // @ts-ignore: store is mocked
        store.trackPagePathOnNode(node.id, pagePath)
      }
    })

    const pendingManifests: Array<INodeManifest> = [
      ...nodes,
      {
        // this node doesn't exist
        id: `4`,
      },
    ].map(node => {
      return {
        pluginName: `test`,
        manifestId: `${node.id}`,
        node,
      }
    })

    // @ts-ignore: store is mocked
    store.setManifests(pendingManifests)

    await processNodeManifests()

    expect(reporter.warn).toBeCalled()
    expect(reporter.warn).toBeCalledWith(
      `Plugin test called unstable_createNodeManifest for a node which doesn't exist with an id of 4.`
    )

    expect(reporter.info).toBeCalled()
    expect(reporter.info).toBeCalledWith(
      `Wrote out ${nodes.length} node page manifest files. 1 manifest couldn't be processed.`
    )
    expect(store.dispatch).toBeCalled()

    // @ts-ignore: store is mocked
    expect(fs.ensureDir.mock.calls.length).toBe(nodes.length)
    // @ts-ignore: store is mocked
    expect(fs.writeJSON.mock.calls.length).toBe(nodes.length)

    pendingManifests.forEach((manifest, index) => {
      // @ts-ignore: store is mocked
      if (!store.getNode(manifest.node.id)) {
        return
      }

      // @ts-ignore: fs is mocked
      const jsonResults = fs.writeJSON.mock.results[index].value

      expect(jsonResults.manifestFilePath).toBe(
        `${path.join(process.cwd(), `.cache`, `node-manifests`, `test`)}/${
          manifest.manifestId
        }.json`
      )

      expect(jsonResults.finalManifest.page.path).toBe(`/${manifest.node.id}`)
    })
  }

  it(`processes node manifests gatsby develop`, async () => {
    process.env.NODE_ENV = `development`
    await testProcessNodeManifests()
    process.env.NODE_ENV = `test`
  })

  it(`processes node manifests gatsby build`, async () => {
    process.env.NODE_ENV = `production`
    await testProcessNodeManifests()
    process.env.NODE_ENV = `test`
  })
})

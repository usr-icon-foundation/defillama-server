
import { AdapterType, IJSON } from "@defillama/dimension-adapters/adapters/types";
import * as HyperExpress from "hyper-express";
import { CATEGORIES } from "../../adaptors/data/helpers/categories";
import { AdaptorRecordType, AdaptorRecordTypeMap } from "../../adaptors/db-utils/adaptor-record";
import { DEFAULT_CHART_BY_ADAPTOR_TYPE } from "../../adaptors/handlers/getOverviewProcess";
import { getDisplayChainNameCached, normalizeDimensionChainsMap } from "../../adaptors/utils/getAllChainsFromAdaptors";
import { sluggifyString } from "../../utils/sluggify";
import { errorResponse, successResponse } from "./utils";
import { computeSummary, getAdapterTypeCache } from "../utils/dimensionsUtils";
import { timeSToUnix, timeSToUnixString } from "../utils/time";
import * as fs from 'fs'
import axios from "axios";

let lastCacheUpdate = new Date().getTime()
const reqCache: any = {}
const sluggifiedNormalizedChains: IJSON<string> = Object.keys(normalizeDimensionChainsMap).reduce((agg, chain) => ({ ...agg, [chain]: sluggifyString(chain.toLowerCase()) }), {})

function clearCache() {
  const now = new Date().getTime()
  if (now - lastCacheUpdate > 30 * 1000) { // clear cache if it is older than 30 seconds
    Object.keys(reqCache).forEach(key => {
      delete reqCache[key]
    })
    lastCacheUpdate = now
  }
}

export async function getOverviewHandler(req: HyperExpress.Request, res: HyperExpress.Response) {
  clearCache()
  const eventParameters = getEventParameters(req)
  const key = JSON.stringify(eventParameters) + 'overview' + Math.random()

  if (!reqCache[key]) {
    console.time(key)
    reqCache[key] = getOverviewProcess(eventParameters)
    console.timeEnd(key)
  }

  return successResponse(res, await reqCache[key], 60);
}

async function getOverviewProcess(eventParameters: any) {
  const adapterType = eventParameters.adaptorType
  const recordType = eventParameters.dataType
  const cacheData = await getAdapterTypeCache(adapterType)
  const { summaries, protocols, allChains } = cacheData
  const chain = eventParameters.chainFilter
  const chainDisplayName = chain ? getDisplayChainNameCached(chain) : null
  let summary = chain ? summaries[recordType].chainSummary[chain] : summaries[recordType]
  const response: any = {}
  if (!summary) summary = {}

  if (!eventParameters.excludeTotalDataChart) {
    response.totalDataChart = formatChartData(summary.chart)
  }

  if (!eventParameters.excludeTotalDataChartBreakdown) {
    response.totalDataChartBreakdown = formatChartData(summary.chartBreakdown)
  }

  response.breakdown24h = null
  response.chain = chain ?? null
  response.allChains = allChains

  // TODO: missing average1y
  const responseKeys = ['total24h', 'total48hto24h', 'total7d', 'total14dto7d', 'total60dto30d', 'total30d', 'total1y', 'average1y', 'change_1d', 'change_7d', 'change_1m', 'change_7dover7d', 'change_30dover30d',]

  responseKeys.forEach(key => {
    response[key] = summary[key]
  })

  response.change_1d = getPercentage(summary.total24h, summary.total48hto24h)
  response.change_7d = getPercentage(summary.total24h, summary.total7DaysAgo)
  response.change_1m = getPercentage(summary.total24h, summary.total30DaysAgo)
  response.change_7dover7d = getPercentage(summary.total7d, summary.total14dto7d)
  response.change_30dover30d = getPercentage(summary.total30d, summary.total60dto30d)

  const protocolInfoKeys = ['defillamaId', 'name', 'disabled', 'displayName', 'module', 'category', 'logo', 'chains', 'protocolType', 'methodologyURL', 'methodology', 'latestFetchIsOk', 'childProtocols', 'parentProtocol', 'slug',]
  const protocolDataKeys = ['total24h', 'total48hto24h', 'total7d', 'total14dto7d', 'total60dto30d', 'total30d', 'total1y', 'totalAllTime', 'average1y', 'change_1d', 'change_7d', 'change_1m', 'change_7dover7d', 'change_30dover30d', 'breakdown24h', 'total14dto7d',]  // TODO: missing breakdown24h/fix it?

  response.protocols = Object.entries(protocols).map(([_id, { summaries, info }]: any) => {
    const res: any = {}

    let summary = summaries?.[recordType]
    if (chain) {
      if (!info?.chains.includes(chainDisplayName)) return null
      summary = summary?.chainSummary[chain]
    }


    if (summary)
      protocolDataKeys.forEach(key => res[key] = summary[key])

    // sometimes a protocol is diabled or id is changed, we should disregard these data 
    if (!summary && !info) {
      // console.log('no data found', _id, info)
      return null
    }


    protocolInfoKeys.filter(key => info?.[key]).forEach(key => res[key] = info?.[key])
    return res
  }).filter((i: any) => i)


  return response
}

function formatChartData(data: any = {}) {
  return Object.entries(data)
    // .filter(([_key, val]: any) => val) // we want to keep 0 values
    .map(([key, value]: any) => [timeSToUnix(key), value]).sort(([a]: any, [b]: any) => a - b)
}

function getPercentage(a: number, b: number) {
  if (!a || !b) return undefined
  return +Number(((a - b) / b) * 100).toFixed(2)
}

async function getProtocolDataHandler(eventParameters: any) {
  const adapterType = eventParameters.adaptorType
  const recordType = eventParameters.dataType
  const cacheData = await getAdapterTypeCache(adapterType)
  const pName = eventParameters.protocolName.replace(/\s+/g, '-').toLowerCase()

  console.time('getProtocolDataHandler: ' + eventParameters.adaptorType)
  let protocolData = cacheData.protocolNameMap[pName]
  let isChildProtocol = false
  let childProtocolVersionKey: string

  if (!protocolData) {
    protocolData = cacheData.childProtocolNameMap[pName]
    if (!protocolData)
      throw new Error("protocol not found")
    isChildProtocol = true
    childProtocolVersionKey = cacheData.childProtocolVersionKeyMap[pName]
  }

  const { records, summaries, info } = protocolData
  let summary = summaries[recordType] ?? {}
  // if (!summary) throw new Error("Missing protocol summary")
  const versionKeyNameMap: IJSON<string> = {}

  let responseInfo = info
  if (isChildProtocol) {
    responseInfo = info.childProtocols.find((i: any) => i.versionKey === childProtocolVersionKey)
    if (info.childProtocols?.length > 1) responseInfo.parentProtocol = info.displayName ?? info.name
  }
  const response: any = { ...responseInfo, childProtocols: null, }
  if (info.childProtocols?.length > 1) {
    response.childProtocols = info.childProtocols.map((child: any) => {
      versionKeyNameMap[child.versionKey] = child.displayName ?? child.name
      return child.displayName ?? child.name
    })
  }


  const getBreakdownLabel = (version: string) => versionKeyNameMap[version] ?? version

  let allRecords = { ...records }

  // we need all the records either to show chart or compute summary for child protocol
  if (eventParameters.excludeTotalDataChart || eventParameters.excludeTotalDataChartBreakdown || isChildProtocol) {
    const commonData = await getAdapterTypeCache(AdapterType.PROTOCOLS)
    const genericRecords = commonData.protocolNameMap[pName]?.records ?? commonData.childProtocolNameMap[pName]?.records ?? {}
    allRecords = { ...genericRecords, ...records }
  }

  if (isChildProtocol) {
    summary = computeSummary({ records: allRecords, versionKey: childProtocolVersionKey!, recordType, })
  }

  const summaryKeys = ['total24h', 'total48hto24h', 'total7d', 'totalAllTime',]
  summaryKeys.forEach(key => response[key] = summary[key])

  if (!eventParameters.excludeTotalDataChart) {
    const chart = {} as any

    Object.entries(allRecords).forEach(([date, value]: any) => {
      if (!value.aggregated[recordType]) return;

      if (!isChildProtocol)
        chart[date] = value.aggregated[recordType]?.value
      else {
        const val = value.breakdown?.[recordType]?.[childProtocolVersionKey]?.value
        if (typeof val === 'number')
          chart[date] = val
      }

    })
    response.totalDataChart = formatChartData(chart)
  }

  if (!eventParameters.excludeTotalDataChartBreakdown) {
    const chartBreakdown = {} as any
    Object.entries(allRecords).forEach(([date, value]: any) => {
      let breakdown = value.breakdown?.[recordType]
      if (!breakdown) {
        breakdown = value.aggregated[recordType]
        if (!breakdown) return;
        breakdown = { [info.name]: breakdown }
      }
      chartBreakdown[date] = formatBreakDownData(breakdown)
    })
    response.totalDataChartBreakdown = formatChartData(chartBreakdown)
  }

  response.chains = response.chains?.map((chain: string) => getDisplayChainNameCached(chain))
  response.change_1d = getPercentage(summary.total24h, summary.total48hto24h)

  console.timeEnd('getProtocolDataHandler: ' + eventParameters.adaptorType)
  return response


  function formatBreakDownData(data: any) {
    const res = {} as any
    Object.entries(data).forEach(([version, { chains }]: any) => {
      if (!chains) return;
      if (isChildProtocol && version !== childProtocolVersionKey) return;
      const label = getBreakdownLabel(version)
      Object.entries(chains).forEach(([chain, value]: any) => {
        if (!res[chain]) res[chain] = {}
        res[chain][label] = value
      })
    })
    if (!Object.keys(res).length) return null
    return res
  }
}

export async function getDimensionProtocolHandler(req: HyperExpress.Request, res: HyperExpress.Response) {
  clearCache()
  const protocolName = req.path_parameters.name?.toLowerCase()
  const adaptorType = req.path_parameters.type?.toLowerCase() as AdapterType
  const eventParameters = getEventParameters(req, false)
  const dataKey = 'protocol-' + JSON.stringify(eventParameters)
  if (!reqCache[dataKey]) {
    console.time('getProtocolDataHandler: ' + dataKey)
    reqCache[dataKey] = getProtocolDataHandler(eventParameters)
    await reqCache[dataKey]
    console.timeEnd('getProtocolDataHandler: ' + dataKey)
  }
  const data = await reqCache[dataKey]
  // const data = await getProtocolDataHandler(eventParameters)
  if (data) return successResponse(res, data, 2 * 60);

  return errorResponse(res, `${adaptorType[0].toUpperCase()}${adaptorType.slice(1)} for ${protocolName} not found, please visit /overview/${adaptorType} to see available protocols`)
}

function getEventParameters(req: HyperExpress.Request, isSummary = true) {
  const adaptorType = req.path_parameters.type?.toLowerCase() as AdapterType
  const excludeTotalDataChart = req.query_parameters.excludeTotalDataChart?.toLowerCase() === 'true'
  const excludeTotalDataChartBreakdown = req.query_parameters.excludeTotalDataChartBreakdown?.toLowerCase() === 'true'
  const rawDataType = req.query_parameters.dataType
  const rawCategory = req.query_parameters.category
  const category = (rawCategory === 'dexs' ? 'dexes' : rawCategory) as CATEGORIES
  const fullChart = req.query_parameters.fullChart?.toLowerCase() === 'true'
  const dataType = rawDataType ? AdaptorRecordTypeMap[rawDataType] : DEFAULT_CHART_BY_ADAPTOR_TYPE[adaptorType]
  if (!adaptorType) throw new Error("Missing parameter")
  if (!Object.values(AdapterType).includes(adaptorType)) throw new Error(`Adaptor ${adaptorType} not supported`)
  if (category !== undefined && !Object.values(CATEGORIES).includes(category)) throw new Error("Category not supported")
  if (!Object.values(AdaptorRecordType).includes(dataType)) throw new Error("Data type not suported")

  if (!isSummary) {
    const protocolName = req.path_parameters.name?.toLowerCase()
    return { adaptorType, dataType, excludeTotalDataChart, excludeTotalDataChartBreakdown, category, fullChart, protocolName }
  }

  const pathChain = req.path_parameters.chain?.toLowerCase()
  const chainFilterRaw = (pathChain ? decodeURI(pathChain) : pathChain)?.toLowerCase()
  const chainFilter = sluggifiedNormalizedChains[chainFilterRaw] ?? chainFilterRaw

  return {
    adaptorType,
    excludeTotalDataChart,
    excludeTotalDataChartBreakdown,
    category,
    fullChart,
    dataType,
    chainFilter,
  }
}

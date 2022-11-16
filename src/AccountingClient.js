import path from 'node:path';
import util from 'node:util';
import fs from 'node:fs/promises';

import axios from 'axios';
import sqlstring from 'sqlstring';
import * as AxiosLogger from 'axios-logger';
import {
  cloneDeep,
  isBoolean,
  isNil,
  isNumber,
  isString,
  isUndefined,
  inRange,
  omitBy,
  isArray,
  transform,
  isObject,
  find,
  findIndex,
  upperFirst,
} from 'lodash-es';

const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url)));

class QuickBooksAccountingClient {
  #accessToken;
  #realmId;
  #minorVersion = 65;
  #useSandbox = process.env.NODE_ENV === 'production' ? false : true;
  #debug = process.env.NODE_ENV === 'production' ? false : true;
  #axios;

  static BASE_URL_PRODUCTION = 'https://quickbooks.api.intuit.com';
  static BASE_URL_SANDBOX = 'https://sandbox-quickbooks.api.intuit.com';
  static QUERY_OPERATORS = ['=', 'IN', '<', '>', '<=', '>=', 'LIKE'];

  /**
   * Create QuickBooksAccountingClient instance
   * @param {Object} config
   * @param {String} config.accessToken
   * @param {String} config.realmId
   * @param {Number=} config.minorVersion
   * @param {Boolean=} config.useSandbox
   * @param {Boolean=} config.debug
   */
  constructor(config = {}) {
    this.#accessToken = config.accessToken;
    this.#realmId = config.realmId;
    if (!isNil(config.minorVersion)) this.#minorVersion = config.minorVersion;
    if (!isNil(config.useSandbox)) this.#useSandbox = config.useSandbox;
    if (!isNil(config.debug)) this.#debug = config.debug;

    if (!this.#accessToken) throw new Error('accessToken not defined');
    if (!this.#realmId) throw new Error('realmId not defined');
    if (!isString(this.#accessToken)) throw new Error('invalid value: accessToken');
    if (!isString(this.#realmId)) throw new Error('invalid value: realmId');
    if (!isNumber(this.#minorVersion) || !inRange(this.#minorVersion, 0, 66))
      throw new Error('invalid value: minorVersion');
    if (!isBoolean(this.#useSandbox)) throw new Error('invalid value: useSandbox');
    if (!isBoolean(this.#debug)) throw new Error('invalid value: debug');

    this.#axios = axios.create({
      baseURL: new URL(
        '/v3/company',
        this.#useSandbox ? QuickBooksAccountingClient.BASE_URL_SANDBOX : QuickBooksAccountingClient.BASE_URL_PRODUCTION
      ).toString(),
      headers: { 'user-agent': `quickbooks-node: version ${packageJson.version}` },
      params: { minorversion: this.#minorVersion },
    });
    if (this.#debug) {
      let loggerConfig = { prefixText: 'QuickBooks', dateFormat: 'HH:MM:ss', headers: true, params: true };
      this.#axios.interceptors.request.use((request) => {
        return AxiosLogger.requestLogger(request, loggerConfig);
      });
      this.#axios.interceptors.response.use((response) => {
        return AxiosLogger.responseLogger(response, loggerConfig);
      });
    }
  }

  /**
   *
   * @param {String} url URL Endpoint of API
   * @param {Object} options Request options
   * @param {'head'|'get'|'post'|'put'|'patch'|'delete'|'options'} options.method
   * @param {Object} options.headers
   * @param {Object} options.params
   * @param {Object|FormData|null} entity
   * @returns {Promise<Object>}
   */
  async #request(url, options, entity) {
    url = path.posix.join('/', this.#realmId, url);
    let method = options.method ?? 'get';
    let headers = options.headers ?? {};
    let params = options.params ?? {};
    let responseType = 'json';

    let defaultHeaders = {
      authorization: `Bearer ${this.#accessToken}`,
    };

    if (!['head', 'get'].includes(method)) defaultHeaders['content-type'] = 'application/json';
    if (url.match(/pdf$/)) {
      defaultHeaders['accept'] = 'application/pdf';
      responseType = 'arraybuffer';
    }

    if (entity?.allowDuplicateDocNum) {
      delete entity.allowDuplicateDocNum;
      params.include = 'allowduplicatedocnum';
    }
    if (entity?.requestId) {
      params.requestid = params.requestid || entity.requestId; // Do not override if exist
      delete entity.requestId;
    }

    // Clean data after several removal
    let data = entity || undefined;

    const aggregatedHeaders = omitBy(
      {
        ...defaultHeaders,
        ...headers, // Can override default headers
      },
      isUndefined
    );

    const response = await this.#axios({
      url,
      method,
      headers: aggregatedHeaders,
      params,
      data,
      responseType,
    });
    return response.data;
  }

  /**
   * Get QuickBooks records
   * @param {String} url URL Endpoint of API
   * @param {Object} options Request options
   * @param {'head'|'get'|'post'|'put'|'patch'|'delete'|'options'} options.method
   * @param {Object} options.headers
   * @param {Object} options.params
   * @param {Object|null} entity
   * @returns {Promise<Object>}
   */
  async #query(entity, parameters) {
    if (isNil(parameters)) parameters = [];
    if (!isObject(parameters)) throw new Error('Invalid query');
    parameters = cloneDeep(parameters); // Create a deep copy of parameters
    if (!isArray(parameters))
      parameters = transform(
        parameters,
        (acc, value, key) => acc.push({ field: key, value, operator: isArray(value) ? 'IN' : '=' }),
        []
      );
    else {
      parameters = parameters.map(({ field, value, operator }) => ({ field, value, operator: operator || '=' }));
    }

    let countIndex = findIndex(parameters, { field: 'count', value: true });
    let count = countIndex !== -1 ? true : false;
    if (count) parameters.splice(countIndex, 1);

    let query = `${count ? 'select count(*) from' : 'select * from'} ${entity}`;

    let limitParams = find(parameters, ['field', 'limit']);
    let offsetParams = find(parameters, ['field', 'offset']);
    if (!limitParams) parameters.push({ field: 'limit', value: 1000 });
    if (!offsetParams) parameters.push({ field: 'offset', value: 1 });
    let fetchAll = Boolean(find(parameters, { field: 'fetchAll', value: true }));

    query += this.#parseQueryParams(parameters, count);

    let response = await this.#request('/query', {
      method: 'get',
      params: { query },
    });
    if (fetchAll && !count) {
      let limitObject = find(parameters, ['field', 'limit']);
      let offsetObject = find(parameters, ['field', 'offset']);
      if (response?.QueryResponse?.maxResults === limitObject.value) {
        offsetObject.value += limitObject.value;
        let responseFields = Object.keys(response.QueryResponse);
        let entityKey = responseFields.find((value) => value.toLowerCase() === entity.toLowerCase());
        let recursiveResponse = await this.#query(entity, parameters);

        response.QueryResponse[entityKey] = response.QueryResponse[entityKey].concat(
          recursiveResponse?.QueryResponse?.[entityKey] || []
        );
        response.QueryResponse.maxResults += recursiveResponse?.QueryResponse?.maxResults || 0;
        response.time = recursiveResponse.time || response.time;
      }
    }
    return response;
  }

  /**
   *
   * @param {Object[]} params Array of query params objects
   * @param {Boolean} count Whether it's a count query or not
   * @returns {String} Parsed query parameters
   */
  #parseQueryParams(params, count = false) {
    let { query, asc, desc, limit, offset } = params.reduce(
      (result, current) => {
        let { field, value, operator } = current;
        if (field === 'fetchAll') return result;
        else if (['asc', 'desc', 'limit', 'offset'].includes(field)) result[field] = value;
        else {
          result['query'] += `${result['query'] ? ' and ' : ''}${field} ${operator} ${
            isArray(value) ? '(' + sqlstring.escape(value) + ')' : sqlstring.escape(value)
          }`;
        }
        return result;
      },
      {
        query: '',
        asc: null,
        desc: null,
        limit: 1000,
        offset: 1,
      }
    );

    if (query) query = ` where ${query}`;
    if (!count) {
      if (asc) query += ` orderby ${asc} asc`;
      if (desc) query += ` orderby ${desc} desc`;
      query += ` startposition ${offset} maxresults ${limit}`;
    }
    return query;
  }

  /**
   * Get QuickBooks report
   * @param {String} reportType Report type
   * @param {Object=} params Query parameters
   * @returns {Promise<Object>}
   */
  async #report(reportType, params) {
    params = params || {};
    let url = path.posix.join('/reports', reportType);
    return await this.#request(url, { method: 'get', params });
  }

  /**
   * Create QuickBooks record
   * @param {String} entityName
   * @param {Object} entity
   * @returns {Promise<Object>}
   */
  async #create(entityName, entity) {
    let url = path.posix.join('/', entityName.toLowerCase());
    let response = await this.#request(url, { method: 'post' }, entity);
    return response?.[upperFirst(entityName)] || response;
  }

  /**
   * Get QuickBooks record
   * @param {String} entityName
   * @param {String} id
   * @returns {Promise<Object>}
   */
  async #read(entityName, id) {
    let url = path.posix.join('/', entityName.toLowerCase(), String(id));
    let response = await this.#request(url, { method: 'get' });
    return response?.[upperFirst(entityName)] || response;
  }

  /**
   * Update QuickBooks record
   * @param {String} entityName
   * @param {Object} entity
   * @returns {Promise<Object>}
   */
  async #update(entityName, entity) {
    if ((!entity.Id || !entity.SyncToken) && entityName !== 'exchangerate')
      throw new Error(
        `${entityName} must contain Id and SyncToken fields: ${util.inspect(entity, {
          showHidden: false,
          depth: null,
        })}`
      );

    let url = path.posix.join('/', entityName.toLowerCase());
    let params = { operation: 'update' };

    if (isNil(entity.sparse)) entity.sparse = true;
    if (entity.void === true) {
      if (entityName === 'invoice') params.operation = 'void';
      else params.include = 'void';
    }
    delete entity.void;

    let response = await this.#request(url, { method: 'post', params }, entity);
    return response?.[upperFirst(entityName)] || response;
  }

  /**
   * Delete QuickBooks record
   * @param {String} entityName
   * @param {Object|String} idOrEntity
   * @returns {Promise<Object>}
   */
  async #delete(entityName, idOrEntity) {
    let url = path.posix.join('/', entityName.toLowerCase());
    let params = { operation: 'delete' };
    let entity = await this.#getEntity(entityName, idOrEntity);
    return await this.#request(url, { method: 'post', params }, entity);
  }

  /**
   * get Entity object from ID or Entity
   * @param {String} entityName
   * @param {Object|String} idOrEntity
   * @returns {Promise<Object>}
   */
  async #getEntity(entityName, idOrEntity) {
    if (isObject(idOrEntity)) return idOrEntity;
    else return await this.#read(entityName, idOrEntity);
  }

  /**
   * Get instance's access token
   * @returns {String}
   */
  getAccessToken() {
    return this.#accessToken;
  }

  /**
   * Update instance's access token
   * @param {String} token
   * @returns {String}
   */
  setAccessToken(token) {
    this.#accessToken = token;
    return this.#accessToken;
  }

  /** --- CODE BELOW THIS POINT IS GENERATED */

  /**
   * Creates Account in QuickBooks
   *
   * @param {Object} accountObject - account object to be persisted in QuickBooks
   * @return {Promise<Object>} account object response
   */
  async createAccount(accountObject) {
    return await this.#create('account', accountObject);
  }

  /**
   * Creates Attachable in QuickBooks
   *
   * @param {Object} attachableObject - attachable object to be persisted in QuickBooks
   * @return {Promise<Object>} attachable object response
   */
  async createAttachable(attachableObject) {
    return await this.#create('attachable', attachableObject);
  }

  /**
   * Creates Bill in QuickBooks
   *
   * @param {Object} billObject - bill object to be persisted in QuickBooks
   * @return {Promise<Object>} bill object response
   */
  async createBill(billObject) {
    return await this.#create('bill', billObject);
  }

  /**
   * Creates BillPayment in QuickBooks
   *
   * @param {Object} billPaymentObject - billPayment object to be persisted in QuickBooks
   * @return {Promise<Object>} billPayment object response
   */
  async createBillPayment(billPaymentObject) {
    return await this.#create('billPayment', billPaymentObject);
  }

  /**
   * Creates Class in QuickBooks
   *
   * @param {Object} classObject - class object to be persisted in QuickBooks
   * @return {Promise<Object>} class object response
   */
  async createClass(classObject) {
    return await this.#create('class', classObject);
  }

  /**
   * Creates CreditMemo in QuickBooks
   *
   * @param {Object} creditMemoObject - creditMemo object to be persisted in QuickBooks
   * @return {Promise<Object>} creditMemo object response
   */
  async createCreditMemo(creditMemoObject) {
    return await this.#create('creditMemo', creditMemoObject);
  }

  /**
   * Creates Customer in QuickBooks
   *
   * @param {Object} customerObject - customer object to be persisted in QuickBooks
   * @return {Promise<Object>} customer object response
   */
  async createCustomer(customerObject) {
    return await this.#create('customer', customerObject);
  }

  /**
   * Creates Department in QuickBooks
   *
   * @param {Object} departmentObject - department object to be persisted in QuickBooks
   * @return {Promise<Object>} department object response
   */
  async createDepartment(departmentObject) {
    return await this.#create('department', departmentObject);
  }

  /**
   * Creates Deposit in QuickBooks
   *
   * @param {Object} depositObject - deposit object to be persisted in QuickBooks
   * @return {Promise<Object>} deposit object response
   */
  async createDeposit(depositObject) {
    return await this.#create('deposit', depositObject);
  }

  /**
   * Creates Employee in QuickBooks
   *
   * @param {Object} employeeObject - employee object to be persisted in QuickBooks
   * @return {Promise<Object>} employee object response
   */
  async createEmployee(employeeObject) {
    return await this.#create('employee', employeeObject);
  }

  /**
   * Creates Estimate in QuickBooks
   *
   * @param {Object} estimateObject - estimate object to be persisted in QuickBooks
   * @return {Promise<Object>} estimate object response
   */
  async createEstimate(estimateObject) {
    return await this.#create('estimate', estimateObject);
  }

  /**
   * Creates Invoice in QuickBooks
   *
   * @param {Object} invoiceObject - invoice object to be persisted in QuickBooks
   * @return {Promise<Object>} invoice object response
   */
  async createInvoice(invoiceObject) {
    return await this.#create('invoice', invoiceObject);
  }

  /**
   * Creates Item in QuickBooks
   *
   * @param {Object} itemObject - item object to be persisted in QuickBooks
   * @return {Promise<Object>} item object response
   */
  async createItem(itemObject) {
    return await this.#create('item', itemObject);
  }

  /**
   * Creates JournalCode in QuickBooks
   *
   * @param {Object} journalCodeObject - journalCode object to be persisted in QuickBooks
   * @return {Promise<Object>} journalCode object response
   */
  async createJournalCode(journalCodeObject) {
    return await this.#create('journalCode', journalCodeObject);
  }

  /**
   * Creates JournalEntry in QuickBooks
   *
   * @param {Object} journalEntryObject - journalEntry object to be persisted in QuickBooks
   * @return {Promise<Object>} journalEntry object response
   */
  async createJournalEntry(journalEntryObject) {
    return await this.#create('journalEntry', journalEntryObject);
  }

  /**
   * Creates Payment in QuickBooks
   *
   * @param {Object} paymentObject - payment object to be persisted in QuickBooks
   * @return {Promise<Object>} payment object response
   */
  async createPayment(paymentObject) {
    return await this.#create('payment', paymentObject);
  }

  /**
   * Creates PaymentMethod in QuickBooks
   *
   * @param {Object} paymentMethodObject - paymentMethod object to be persisted in QuickBooks
   * @return {Promise<Object>} paymentMethod object response
   */
  async createPaymentMethod(paymentMethodObject) {
    return await this.#create('paymentMethod', paymentMethodObject);
  }

  /**
   * Creates Purchase in QuickBooks
   *
   * @param {Object} purchaseObject - purchase object to be persisted in QuickBooks
   * @return {Promise<Object>} purchase object response
   */
  async createPurchase(purchaseObject) {
    return await this.#create('purchase', purchaseObject);
  }

  /**
   * Creates PurchaseOrder in QuickBooks
   *
   * @param {Object} purchaseOrderObject - purchaseOrder object to be persisted in QuickBooks
   * @return {Promise<Object>} purchaseOrder object response
   */
  async createPurchaseOrder(purchaseOrderObject) {
    return await this.#create('purchaseOrder', purchaseOrderObject);
  }

  /**
   * Creates RefundReceipt in QuickBooks
   *
   * @param {Object} refundReceiptObject - refundReceipt object to be persisted in QuickBooks
   * @return {Promise<Object>} refundReceipt object response
   */
  async createRefundReceipt(refundReceiptObject) {
    return await this.#create('refundReceipt', refundReceiptObject);
  }

  /**
   * Creates SalesReceipt in QuickBooks
   *
   * @param {Object} salesReceiptObject - salesReceipt object to be persisted in QuickBooks
   * @return {Promise<Object>} salesReceipt object response
   */
  async createSalesReceipt(salesReceiptObject) {
    return await this.#create('salesReceipt', salesReceiptObject);
  }

  /**
   * Creates TaxAgency in QuickBooks
   *
   * @param {Object} taxAgencyObject - taxAgency object to be persisted in QuickBooks
   * @return {Promise<Object>} taxAgency object response
   */
  async createTaxAgency(taxAgencyObject) {
    return await this.#create('taxAgency', taxAgencyObject);
  }

  /**
   * Creates TaxService in QuickBooks
   *
   * @param {Object} taxServiceObject - taxService object to be persisted in QuickBooks
   * @return {Promise<Object>} taxService object response
   */
  async createTaxService(taxServiceObject) {
    return await this.#create('taxService', taxServiceObject);
  }

  /**
   * Creates Term in QuickBooks
   *
   * @param {Object} termObject - term object to be persisted in QuickBooks
   * @return {Promise<Object>} term object response
   */
  async createTerm(termObject) {
    return await this.#create('term', termObject);
  }

  /**
   * Creates TimeActivity in QuickBooks
   *
   * @param {Object} timeActivityObject - timeActivity object to be persisted in QuickBooks
   * @return {Promise<Object>} timeActivity object response
   */
  async createTimeActivity(timeActivityObject) {
    return await this.#create('timeActivity', timeActivityObject);
  }

  /**
   * Creates Transfer in QuickBooks
   *
   * @param {Object} transferObject - transfer object to be persisted in QuickBooks
   * @return {Promise<Object>} transfer object response
   */
  async createTransfer(transferObject) {
    return await this.#create('transfer', transferObject);
  }

  /**
   * Creates Vendor in QuickBooks
   *
   * @param {Object} vendorObject - vendor object to be persisted in QuickBooks
   * @return {Promise<Object>} vendor object response
   */
  async createVendor(vendorObject) {
    return await this.#create('vendor', vendorObject);
  }

  /**
   * Creates VendorCredit in QuickBooks
   *
   * @param {Object} vendorCreditObject - vendorCredit object to be persisted in QuickBooks
   * @return {Promise<Object>} vendorCredit object response
   */
  async createVendorCredit(vendorCreditObject) {
    return await this.#create('vendorCredit', vendorCreditObject);
  }

  /**
   * Retrieve Account from QuickBooks
   *
   * @param {String} id - account's ID to be retrieved.
   * @return {Promise<Object>} account object response
   */
  async getAccount(id) {
    return await this.#read('account', id);
  }

  /**
   * Retrieve Attachable from QuickBooks
   *
   * @param {String} id - attachable's ID to be retrieved.
   * @return {Promise<Object>} attachable object response
   */
  async getAttachable(id) {
    return await this.#read('attachable', id);
  }

  /**
   * Retrieve Bill from QuickBooks
   *
   * @param {String} id - bill's ID to be retrieved.
   * @return {Promise<Object>} bill object response
   */
  async getBill(id) {
    return await this.#read('bill', id);
  }

  /**
   * Retrieve BillPayment from QuickBooks
   *
   * @param {String} id - billPayment's ID to be retrieved.
   * @return {Promise<Object>} billPayment object response
   */
  async getBillPayment(id) {
    return await this.#read('billPayment', id);
  }

  /**
   * Retrieve Class from QuickBooks
   *
   * @param {String} id - class's ID to be retrieved.
   * @return {Promise<Object>} class object response
   */
  async getClass(id) {
    return await this.#read('class', id);
  }

  /**
   * Retrieve CompanyInfo from QuickBooks
   *
   * @param {String} id - companyInfo's ID to be retrieved.
   * @return {Promise<Object>} companyInfo object response
   */
  async getCompanyInfo(id) {
    return await this.#read('companyInfo', id);
  }

  /**
   * Retrieve CreditMemo from QuickBooks
   *
   * @param {String} id - creditMemo's ID to be retrieved.
   * @return {Promise<Object>} creditMemo object response
   */
  async getCreditMemo(id) {
    return await this.#read('creditMemo', id);
  }

  /**
   * Retrieve Customer from QuickBooks
   *
   * @param {String} id - customer's ID to be retrieved.
   * @return {Promise<Object>} customer object response
   */
  async getCustomer(id) {
    return await this.#read('customer', id);
  }

  /**
   * Retrieve Department from QuickBooks
   *
   * @param {String} id - department's ID to be retrieved.
   * @return {Promise<Object>} department object response
   */
  async getDepartment(id) {
    return await this.#read('department', id);
  }

  /**
   * Retrieve Deposit from QuickBooks
   *
   * @param {String} id - deposit's ID to be retrieved.
   * @return {Promise<Object>} deposit object response
   */
  async getDeposit(id) {
    return await this.#read('deposit', id);
  }

  /**
   * Retrieve Employee from QuickBooks
   *
   * @param {String} id - employee's ID to be retrieved.
   * @return {Promise<Object>} employee object response
   */
  async getEmployee(id) {
    return await this.#read('employee', id);
  }

  /**
   * Retrieve Estimate from QuickBooks
   *
   * @param {String} id - estimate's ID to be retrieved.
   * @return {Promise<Object>} estimate object response
   */
  async getEstimate(id) {
    return await this.#read('estimate', id);
  }

  /**
   * Retrieve ExchangeRate from QuickBooks
   *
   * @param {String} id - exchangeRate's ID to be retrieved.
   * @return {Promise<Object>} exchangeRate object response
   */
  async getExchangeRate(id) {
    return await this.#read('exchangeRate', id);
  }

  /**
   * Retrieve Invoice from QuickBooks
   *
   * @param {String} id - invoice's ID to be retrieved.
   * @return {Promise<Object>} invoice object response
   */
  async getInvoice(id) {
    return await this.#read('invoice', id);
  }

  /**
   * Retrieve Item from QuickBooks
   *
   * @param {String} id - item's ID to be retrieved.
   * @return {Promise<Object>} item object response
   */
  async getItem(id) {
    return await this.#read('item', id);
  }

  /**
   * Retrieve JournalCode from QuickBooks
   *
   * @param {String} id - journalCode's ID to be retrieved.
   * @return {Promise<Object>} journalCode object response
   */
  async getJournalCode(id) {
    return await this.#read('journalCode', id);
  }

  /**
   * Retrieve JournalEntry from QuickBooks
   *
   * @param {String} id - journalEntry's ID to be retrieved.
   * @return {Promise<Object>} journalEntry object response
   */
  async getJournalEntry(id) {
    return await this.#read('journalEntry', id);
  }

  /**
   * Retrieve Payment from QuickBooks
   *
   * @param {String} id - payment's ID to be retrieved.
   * @return {Promise<Object>} payment object response
   */
  async getPayment(id) {
    return await this.#read('payment', id);
  }

  /**
   * Retrieve PaymentMethod from QuickBooks
   *
   * @param {String} id - paymentMethod's ID to be retrieved.
   * @return {Promise<Object>} paymentMethod object response
   */
  async getPaymentMethod(id) {
    return await this.#read('paymentMethod', id);
  }

  /**
   * Retrieve Preferences from QuickBooks
   *
   * @param {String} id - preferences's ID to be retrieved.
   * @return {Promise<Object>} preferences object response
   */
  async getPreferences(id) {
    return await this.#read('preferences', id);
  }

  /**
   * Retrieve Purchase from QuickBooks
   *
   * @param {String} id - purchase's ID to be retrieved.
   * @return {Promise<Object>} purchase object response
   */
  async getPurchase(id) {
    return await this.#read('purchase', id);
  }

  /**
   * Retrieve PurchaseOrder from QuickBooks
   *
   * @param {String} id - purchaseOrder's ID to be retrieved.
   * @return {Promise<Object>} purchaseOrder object response
   */
  async getPurchaseOrder(id) {
    return await this.#read('purchaseOrder', id);
  }

  /**
   * Retrieve RefundReceipt from QuickBooks
   *
   * @param {String} id - refundReceipt's ID to be retrieved.
   * @return {Promise<Object>} refundReceipt object response
   */
  async getRefundReceipt(id) {
    return await this.#read('refundReceipt', id);
  }

  /**
   * Retrieve Reports from QuickBooks
   *
   * @param {String} id - reports's ID to be retrieved.
   * @return {Promise<Object>} reports object response
   */
  async getReports(id) {
    return await this.#read('reports', id);
  }

  /**
   * Retrieve SalesReceipt from QuickBooks
   *
   * @param {String} id - salesReceipt's ID to be retrieved.
   * @return {Promise<Object>} salesReceipt object response
   */
  async getSalesReceipt(id) {
    return await this.#read('salesReceipt', id);
  }

  /**
   * Retrieve TaxAgency from QuickBooks
   *
   * @param {String} id - taxAgency's ID to be retrieved.
   * @return {Promise<Object>} taxAgency object response
   */
  async getTaxAgency(id) {
    return await this.#read('taxAgency', id);
  }

  /**
   * Retrieve TaxCode from QuickBooks
   *
   * @param {String} id - taxCode's ID to be retrieved.
   * @return {Promise<Object>} taxCode object response
   */
  async getTaxCode(id) {
    return await this.#read('taxCode', id);
  }

  /**
   * Retrieve TaxRate from QuickBooks
   *
   * @param {String} id - taxRate's ID to be retrieved.
   * @return {Promise<Object>} taxRate object response
   */
  async getTaxRate(id) {
    return await this.#read('taxRate', id);
  }

  /**
   * Retrieve Term from QuickBooks
   *
   * @param {String} id - term's ID to be retrieved.
   * @return {Promise<Object>} term object response
   */
  async getTerm(id) {
    return await this.#read('term', id);
  }

  /**
   * Retrieve TimeActivity from QuickBooks
   *
   * @param {String} id - timeActivity's ID to be retrieved.
   * @return {Promise<Object>} timeActivity object response
   */
  async getTimeActivity(id) {
    return await this.#read('timeActivity', id);
  }

  /**
   * Retrieve Vendor from QuickBooks
   *
   * @param {String} id - vendor's ID to be retrieved.
   * @return {Promise<Object>} vendor object response
   */
  async getVendor(id) {
    return await this.#read('vendor', id);
  }

  /**
   * Retrieve VendorCredit from QuickBooks
   *
   * @param {String} id - vendorCredit's ID to be retrieved.
   * @return {Promise<Object>} vendorCredit object response
   */
  async getVendorCredit(id) {
    return await this.#read('vendorCredit', id);
  }

  /**
   * Updates Account entity in QuickBooks
   *
   * @param {Object} accountObject - account object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} account object response
   */
  async updateAccount(accountObject) {
    return await this.#update('account', accountObject);
  }

  /**
   * Updates Attachable entity in QuickBooks
   *
   * @param {Object} attachableObject - attachable object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} attachable object response
   */
  async updateAttachable(attachableObject) {
    return await this.#update('attachable', attachableObject);
  }

  /**
   * Updates Bill entity in QuickBooks
   *
   * @param {Object} billObject - bill object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} bill object response
   */
  async updateBill(billObject) {
    return await this.#update('bill', billObject);
  }

  /**
   * Updates BillPayment entity in QuickBooks
   *
   * @param {Object} billPaymentObject - billPayment object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} billPayment object response
   */
  async updateBillPayment(billPaymentObject) {
    return await this.#update('billPayment', billPaymentObject);
  }

  /**
   * Updates Class entity in QuickBooks
   *
   * @param {Object} classObject - class object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} class object response
   */
  async updateClass(classObject) {
    return await this.#update('class', classObject);
  }

  /**
   * Updates CompanyInfo entity in QuickBooks
   *
   * @param {Object} companyInfoObject - companyInfo object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} companyInfo object response
   */
  async updateCompanyInfo(companyInfoObject) {
    return await this.#update('companyInfo', companyInfoObject);
  }

  /**
   * Updates CreditMemo entity in QuickBooks
   *
   * @param {Object} creditMemoObject - creditMemo object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} creditMemo object response
   */
  async updateCreditMemo(creditMemoObject) {
    return await this.#update('creditMemo', creditMemoObject);
  }

  /**
   * Updates Customer entity in QuickBooks
   *
   * @param {Object} customerObject - customer object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} customer object response
   */
  async updateCustomer(customerObject) {
    return await this.#update('customer', customerObject);
  }

  /**
   * Updates Department entity in QuickBooks
   *
   * @param {Object} departmentObject - department object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} department object response
   */
  async updateDepartment(departmentObject) {
    return await this.#update('department', departmentObject);
  }

  /**
   * Updates Deposit entity in QuickBooks
   *
   * @param {Object} depositObject - deposit object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} deposit object response
   */
  async updateDeposit(depositObject) {
    return await this.#update('deposit', depositObject);
  }

  /**
   * Updates Employee entity in QuickBooks
   *
   * @param {Object} employeeObject - employee object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} employee object response
   */
  async updateEmployee(employeeObject) {
    return await this.#update('employee', employeeObject);
  }

  /**
   * Updates Estimate entity in QuickBooks
   *
   * @param {Object} estimateObject - estimate object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} estimate object response
   */
  async updateEstimate(estimateObject) {
    return await this.#update('estimate', estimateObject);
  }

  /**
   * Updates ExchangeRate entity in QuickBooks
   *
   * @param {Object} exchangeRateObject - exchangeRate object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} exchangeRate object response
   */
  async updateExchangeRate(exchangeRateObject) {
    return await this.#update('exchangeRate', exchangeRateObject);
  }

  /**
   * Updates Invoice entity in QuickBooks
   *
   * @param {Object} invoiceObject - invoice object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} invoice object response
   */
  async updateInvoice(invoiceObject) {
    return await this.#update('invoice', invoiceObject);
  }

  /**
   * Updates Item entity in QuickBooks
   *
   * @param {Object} itemObject - item object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} item object response
   */
  async updateItem(itemObject) {
    return await this.#update('item', itemObject);
  }

  /**
   * Updates JournalCode entity in QuickBooks
   *
   * @param {Object} journalCodeObject - journalCode object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} journalCode object response
   */
  async updateJournalCode(journalCodeObject) {
    return await this.#update('journalCode', journalCodeObject);
  }

  /**
   * Updates JournalEntry entity in QuickBooks
   *
   * @param {Object} journalEntryObject - journalEntry object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} journalEntry object response
   */
  async updateJournalEntry(journalEntryObject) {
    return await this.#update('journalEntry', journalEntryObject);
  }

  /**
   * Updates Payment entity in QuickBooks
   *
   * @param {Object} paymentObject - payment object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} payment object response
   */
  async updatePayment(paymentObject) {
    return await this.#update('payment', paymentObject);
  }

  /**
   * Updates PaymentMethod entity in QuickBooks
   *
   * @param {Object} paymentMethodObject - paymentMethod object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} paymentMethod object response
   */
  async updatePaymentMethod(paymentMethodObject) {
    return await this.#update('paymentMethod', paymentMethodObject);
  }

  /**
   * Updates Preferences entity in QuickBooks
   *
   * @param {Object} preferencesObject - preferences object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} preferences object response
   */
  async updatePreferences(preferencesObject) {
    return await this.#update('preferences', preferencesObject);
  }

  /**
   * Updates Purchase entity in QuickBooks
   *
   * @param {Object} purchaseObject - purchase object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} purchase object response
   */
  async updatePurchase(purchaseObject) {
    return await this.#update('purchase', purchaseObject);
  }

  /**
   * Updates PurchaseOrder entity in QuickBooks
   *
   * @param {Object} purchaseOrderObject - purchaseOrder object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} purchaseOrder object response
   */
  async updatePurchaseOrder(purchaseOrderObject) {
    return await this.#update('purchaseOrder', purchaseOrderObject);
  }

  /**
   * Updates RefundReceipt entity in QuickBooks
   *
   * @param {Object} refundReceiptObject - refundReceipt object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} refundReceipt object response
   */
  async updateRefundReceipt(refundReceiptObject) {
    return await this.#update('refundReceipt', refundReceiptObject);
  }

  /**
   * Updates SalesReceipt entity in QuickBooks
   *
   * @param {Object} salesReceiptObject - salesReceipt object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} salesReceipt object response
   */
  async updateSalesReceipt(salesReceiptObject) {
    return await this.#update('salesReceipt', salesReceiptObject);
  }

  /**
   * Updates TaxAgency entity in QuickBooks
   *
   * @param {Object} taxAgencyObject - taxAgency object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} taxAgency object response
   */
  async updateTaxAgency(taxAgencyObject) {
    return await this.#update('taxAgency', taxAgencyObject);
  }

  /**
   * Updates TaxCode entity in QuickBooks
   *
   * @param {Object} taxCodeObject - taxCode object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} taxCode object response
   */
  async updateTaxCode(taxCodeObject) {
    return await this.#update('taxCode', taxCodeObject);
  }

  /**
   * Updates TaxRate entity in QuickBooks
   *
   * @param {Object} taxRateObject - taxRate object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} taxRate object response
   */
  async updateTaxRate(taxRateObject) {
    return await this.#update('taxRate', taxRateObject);
  }

  /**
   * Updates TaxService entity in QuickBooks
   *
   * @param {Object} taxServiceObject - taxService object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} taxService object response
   */
  async updateTaxService(taxServiceObject) {
    return await this.#update('taxService', taxServiceObject);
  }

  /**
   * Updates Term entity in QuickBooks
   *
   * @param {Object} termObject - term object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} term object response
   */
  async updateTerm(termObject) {
    return await this.#update('term', termObject);
  }

  /**
   * Updates TimeActivity entity in QuickBooks
   *
   * @param {Object} timeActivityObject - timeActivity object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} timeActivity object response
   */
  async updateTimeActivity(timeActivityObject) {
    return await this.#update('timeActivity', timeActivityObject);
  }

  /**
   * Updates Transfer entity in QuickBooks
   *
   * @param {Object} transferObject - transfer object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} transfer object response
   */
  async updateTransfer(transferObject) {
    return await this.#update('transfer', transferObject);
  }

  /**
   * Updates Vendor entity in QuickBooks
   *
   * @param {Object} vendorObject - vendor object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} vendor object response
   */
  async updateVendor(vendorObject) {
    return await this.#update('vendor', vendorObject);
  }

  /**
   * Updates VendorCredit entity in QuickBooks
   *
   * @param {Object} vendorCreditObject - vendorCredit object to be updated in QuickBooks (Must include Id and SyncToken fields)
   * @return {Promise<Object>} vendorCredit object response
   */
  async updateVendorCredit(vendorCreditObject) {
    return await this.#update('vendorCredit', vendorCreditObject);
  }

  /**
   * Remove Attachable entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - attachable's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} attachable object response
   */
  async deleteAttachable(idOrEntity) {
    return await this.#delete('attachable', idOrEntity);
  }

  /**
   * Remove Bill entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - bill's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} bill object response
   */
  async deleteBill(idOrEntity) {
    return await this.#delete('bill', idOrEntity);
  }

  /**
   * Remove BillPayment entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - billPayment's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} billPayment object response
   */
  async deleteBillPayment(idOrEntity) {
    return await this.#delete('billPayment', idOrEntity);
  }

  /**
   * Remove CreditMemo entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - creditMemo's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} creditMemo object response
   */
  async deleteCreditMemo(idOrEntity) {
    return await this.#delete('creditMemo', idOrEntity);
  }

  /**
   * Remove Deposit entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - deposit's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} deposit object response
   */
  async deleteDeposit(idOrEntity) {
    return await this.#delete('deposit', idOrEntity);
  }

  /**
   * Remove Estimate entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - estimate's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} estimate object response
   */
  async deleteEstimate(idOrEntity) {
    return await this.#delete('estimate', idOrEntity);
  }

  /**
   * Remove Invoice entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - invoice's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} invoice object response
   */
  async deleteInvoice(idOrEntity) {
    return await this.#delete('invoice', idOrEntity);
  }

  /**
   * Remove JournalCode entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - journalCode's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} journalCode object response
   */
  async deleteJournalCode(idOrEntity) {
    return await this.#delete('journalCode', idOrEntity);
  }

  /**
   * Remove JournalEntry entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - journalEntry's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} journalEntry object response
   */
  async deleteJournalEntry(idOrEntity) {
    return await this.#delete('journalEntry', idOrEntity);
  }

  /**
   * Remove Payment entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - payment's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} payment object response
   */
  async deletePayment(idOrEntity) {
    return await this.#delete('payment', idOrEntity);
  }

  /**
   * Remove Purchase entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - purchase's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} purchase object response
   */
  async deletePurchase(idOrEntity) {
    return await this.#delete('purchase', idOrEntity);
  }

  /**
   * Remove PurchaseOrder entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - purchaseOrder's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} purchaseOrder object response
   */
  async deletePurchaseOrder(idOrEntity) {
    return await this.#delete('purchaseOrder', idOrEntity);
  }

  /**
   * Remove RefundReceipt entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - refundReceipt's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} refundReceipt object response
   */
  async deleteRefundReceipt(idOrEntity) {
    return await this.#delete('refundReceipt', idOrEntity);
  }

  /**
   * Remove SalesReceipt entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - salesReceipt's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} salesReceipt object response
   */
  async deleteSalesReceipt(idOrEntity) {
    return await this.#delete('salesReceipt', idOrEntity);
  }

  /**
   * Remove TimeActivity entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - timeActivity's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} timeActivity object response
   */
  async deleteTimeActivity(idOrEntity) {
    return await this.#delete('timeActivity', idOrEntity);
  }

  /**
   * Remove Transfer entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - transfer's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} transfer object response
   */
  async deleteTransfer(idOrEntity) {
    return await this.#delete('transfer', idOrEntity);
  }

  /**
   * Remove VendorCredit entity from QuickBooks
   *
   * @param {Object|String} idOrEntity - vendorCredit's ID or object to be removed from QuickBooks
   * @return {Promise<Object>} vendorCredit object response
   */
  async deleteVendorCredit(idOrEntity) {
    return await this.#delete('vendorCredit', idOrEntity);
  }

  /**
   * Find Account entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} account object response
   */
  async findAccounts(query) {
    return await this.#query('Account', query);
  }

  /**
   * Find Attachable entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} attachable object response
   */
  async findAttachables(query) {
    return await this.#query('Attachable', query);
  }

  /**
   * Find Bill entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} bill object response
   */
  async findBills(query) {
    return await this.#query('Bill', query);
  }

  /**
   * Find BillPayment entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} billPayment object response
   */
  async findBillPayments(query) {
    return await this.#query('BillPayment', query);
  }

  /**
   * Find Budget entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} budget object response
   */
  async findBudgets(query) {
    return await this.#query('Budget', query);
  }

  /**
   * Find Class entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} class object response
   */
  async findClasses(query) {
    return await this.#query('Class', query);
  }

  /**
   * Find CompanyInfo entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} companyInfo object response
   */
  async findCompanyInfos(query) {
    return await this.#query('CompanyInfo', query);
  }

  /**
   * Find CreditMemo entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} creditMemo object response
   */
  async findCreditMemos(query) {
    return await this.#query('CreditMemo', query);
  }

  /**
   * Find Customer entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} customer object response
   */
  async findCustomers(query) {
    return await this.#query('Customer', query);
  }

  /**
   * Find Department entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} department object response
   */
  async findDepartments(query) {
    return await this.#query('Department', query);
  }

  /**
   * Find Deposit entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} deposit object response
   */
  async findDeposits(query) {
    return await this.#query('Deposit', query);
  }

  /**
   * Find Employee entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} employee object response
   */
  async findEmployees(query) {
    return await this.#query('Employee', query);
  }

  /**
   * Find Estimate entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} estimate object response
   */
  async findEstimates(query) {
    return await this.#query('Estimate', query);
  }

  /**
   * Find ExchangeRate entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} exchangeRate object response
   */
  async findExchangeRates(query) {
    return await this.#query('ExchangeRate', query);
  }

  /**
   * Find Invoice entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} invoice object response
   */
  async findInvoices(query) {
    return await this.#query('Invoice', query);
  }

  /**
   * Find Item entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} item object response
   */
  async findItems(query) {
    return await this.#query('Item', query);
  }

  /**
   * Find JournalCode entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} journalCode object response
   */
  async findJournalCodes(query) {
    return await this.#query('JournalCode', query);
  }

  /**
   * Find JournalEntry entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} journalEntry object response
   */
  async findJournalEntries(query) {
    return await this.#query('JournalEntry', query);
  }

  /**
   * Find Payment entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} payment object response
   */
  async findPayments(query) {
    return await this.#query('Payment', query);
  }

  /**
   * Find PaymentMethod entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} paymentMethod object response
   */
  async findPaymentMethods(query) {
    return await this.#query('PaymentMethod', query);
  }

  /**
   * Find Preferences entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} preferences object response
   */
  async findPreferences(query) {
    return await this.#query('Preferences', query);
  }

  /**
   * Find Purchase entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} purchase object response
   */
  async findPurchases(query) {
    return await this.#query('Purchase', query);
  }

  /**
   * Find PurchaseOrder entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} purchaseOrder object response
   */
  async findPurchaseOrders(query) {
    return await this.#query('PurchaseOrder', query);
  }

  /**
   * Find RefundReceipt entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} refundReceipt object response
   */
  async findRefundReceipts(query) {
    return await this.#query('RefundReceipt', query);
  }

  /**
   * Find SalesReceipt entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} salesReceipt object response
   */
  async findSalesReceipts(query) {
    return await this.#query('SalesReceipt', query);
  }

  /**
   * Find TaxAgency entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} taxAgency object response
   */
  async findTaxAgencies(query) {
    return await this.#query('TaxAgency', query);
  }

  /**
   * Find TaxCode entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} taxCode object response
   */
  async findTaxCodes(query) {
    return await this.#query('TaxCode', query);
  }

  /**
   * Find TaxRate entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} taxRate object response
   */
  async findTaxRates(query) {
    return await this.#query('TaxRate', query);
  }

  /**
   * Find Term entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} term object response
   */
  async findTerms(query) {
    return await this.#query('Term', query);
  }

  /**
   * Find TimeActivity entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} timeActivity object response
   */
  async findTimeActivities(query) {
    return await this.#query('TimeActivity', query);
  }

  /**
   * Find Vendor entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} vendor object response
   */
  async findVendors(query) {
    return await this.#query('Vendor', query);
  }

  /**
   * Find VendorCredit entities in QuickBooks, optionally sending parameters to be used as query condition / filter
   *
   * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
   * @return {Promise<Object>} vendorCredit object response
   */
  async findVendorCredits(query) {
    return await this.#query('VendorCredit', query);
  }

  /**
   * Retrieve AccountList report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} AccountList object response
   */
  async reportAccountList(params) {
    return await this.#report('AccountList', params);
  }

  /**
   * Retrieve AgedPayableDetail report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} AgedPayableDetail object response
   */
  async reportAgedPayableDetail(params) {
    return await this.#report('AgedPayableDetail', params);
  }

  /**
   * Retrieve AgedPayables report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} AgedPayables object response
   */
  async reportAgedPayables(params) {
    return await this.#report('AgedPayables', params);
  }

  /**
   * Retrieve AgedReceivableDetail report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} AgedReceivableDetail object response
   */
  async reportAgedReceivableDetail(params) {
    return await this.#report('AgedReceivableDetail', params);
  }

  /**
   * Retrieve AgedReceivables report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} AgedReceivables object response
   */
  async reportAgedReceivables(params) {
    return await this.#report('AgedReceivables', params);
  }

  /**
   * Retrieve BalanceSheet report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} BalanceSheet object response
   */
  async reportBalanceSheet(params) {
    return await this.#report('BalanceSheet', params);
  }

  /**
   * Retrieve CashFlow report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} CashFlow object response
   */
  async reportCashFlow(params) {
    return await this.#report('CashFlow', params);
  }

  /**
   * Retrieve CustomerBalance report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} CustomerBalance object response
   */
  async reportCustomerBalance(params) {
    return await this.#report('CustomerBalance', params);
  }

  /**
   * Retrieve CustomerBalanceDetail report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} CustomerBalanceDetail object response
   */
  async reportCustomerBalanceDetail(params) {
    return await this.#report('CustomerBalanceDetail', params);
  }

  /**
   * Retrieve CustomerIncome report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} CustomerIncome object response
   */
  async reportCustomerIncome(params) {
    return await this.#report('CustomerIncome', params);
  }

  /**
   * Retrieve FECReport report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} FECReport object response
   */
  async reportFECReport(params) {
    return await this.#report('FECReport', params);
  }

  /**
   * Retrieve GeneralLedger report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} GeneralLedger object response
   */
  async reportGeneralLedger(params) {
    return await this.#report('GeneralLedger', params);
  }

  /**
   * Retrieve GeneralLedgerFR report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} GeneralLedgerFR object response
   */
  async reportGeneralLedgerFR(params) {
    return await this.#report('GeneralLedgerFR', params);
  }

  /**
   * Retrieve InventoryValuationSummary report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} InventoryValuationSummary object response
   */
  async reportInventoryValuationSummary(params) {
    return await this.#report('InventoryValuationSummary', params);
  }

  /**
   * Retrieve JournalReport report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} JournalReport object response
   */
  async reportJournalReport(params) {
    return await this.#report('JournalReport', params);
  }

  /**
   * Retrieve ProfitAndLoss report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} ProfitAndLoss object response
   */
  async reportProfitAndLoss(params) {
    return await this.#report('ProfitAndLoss', params);
  }

  /**
   * Retrieve ProfitAndLossDetail report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} ProfitAndLossDetail object response
   */
  async reportProfitAndLossDetail(params) {
    return await this.#report('ProfitAndLossDetail', params);
  }

  /**
   * Retrieve ClassSales report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} ClassSales object response
   */
  async reportClassSales(params) {
    return await this.#report('ClassSales', params);
  }

  /**
   * Retrieve CustomerSales report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} CustomerSales object response
   */
  async reportCustomerSales(params) {
    return await this.#report('CustomerSales', params);
  }

  /**
   * Retrieve DepartmentSales report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} DepartmentSales object response
   */
  async reportDepartmentSales(params) {
    return await this.#report('DepartmentSales', params);
  }

  /**
   * Retrieve ItemSales report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} ItemSales object response
   */
  async reportItemSales(params) {
    return await this.#report('ItemSales', params);
  }

  /**
   * Retrieve TaxSummary report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} TaxSummary object response
   */
  async reportTaxSummary(params) {
    return await this.#report('TaxSummary', params);
  }

  /**
   * Retrieve TransactionList report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} TransactionList object response
   */
  async reportTransactionList(params) {
    return await this.#report('TransactionList', params);
  }

  /**
   * Retrieve TransactionListByCustomer report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} TransactionListByCustomer object response
   */
  async reportTransactionListByCustomer(params) {
    return await this.#report('TransactionListByCustomer', params);
  }

  /**
   * Retrieve TransactionListByVendor report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} TransactionListByVendor object response
   */
  async reportTransactionListByVendor(params) {
    return await this.#report('TransactionListByVendor', params);
  }

  /**
   * Retrieve TransactionListWithSplits report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} TransactionListWithSplits object response
   */
  async reportTransactionListWithSplits(params) {
    return await this.#report('TransactionListWithSplits', params);
  }

  /**
   * Retrieve TrialBalance report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} TrialBalance object response
   */
  async reportTrialBalance(params) {
    return await this.#report('TrialBalance', params);
  }

  /**
   * Retrieve VendorBalance report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} VendorBalance object response
   */
  async reportVendorBalance(params) {
    return await this.#report('VendorBalance', params);
  }

  /**
   * Retrieve VendorBalanceDetail report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} VendorBalanceDetail object response
   */
  async reportVendorBalanceDetail(params) {
    return await this.#report('VendorBalanceDetail', params);
  }

  /**
   * Retrieve VendorExpenses report from QuickBooks
   *
   * @param {Object=} params - parameter object to be send as condition / filter
   * @return {Promise<Object>} VendorExpenses object response
   */
  async reportVendorExpenses(params) {
    return await this.#report('VendorExpenses', params);
  }
}

export default QuickBooksAccountingClient;

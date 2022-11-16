/* eslint-disable node/no-unpublished-import */

import fs from 'node:fs/promises';
import { ESLint } from 'eslint';
import pluralize from 'pluralize';
import { upperFirst, forEach } from 'lodash-es';

const apiList = JSON.parse(await fs.readFile(new URL('./apiList.json', import.meta.url)));

let header = `
/* eslint-disable no-unused-vars */

class QuickBooksAccountingClient {

  async #create(entityName, entity) {}
  async #read(entityName, id) {}
  async #update(entityName, entity) {}
  async #delete(entityName, idOrEntity) {}
  async #query(entity, parameters) {}
  async #report(reportType, params) {}

`;

let footer = `
};

export default QuickBooksAccountingClient;
`;

const create = (name) => {
  return `
/**
 * Creates ${upperFirst(name)} in QuickBooks
 * 
 * @param {Object} ${name}Object - ${name} object to be persisted in QuickBooks
 * @return {Promise<Object>} ${name} object response
 */
async create${upperFirst(name)}(${name}Object) {
  return await this.#create('${name}', ${name}Object);
}
`;
};

const read = (name) => {
  return `
/**
 * Retrieve ${upperFirst(name)} from QuickBooks
 * 
 * @param {String} id - ${name}'s ID to be retrieved.
 * @return {Promise<Object>} ${name} object response
 */
async get${upperFirst(name)}(id) {
  return await this.#read('${name}', id);
}
`;
};

const update = (name) => {
  return `
/**
 * Updates ${upperFirst(name)} entity in QuickBooks
 * 
 * @param {Object} ${name}Object - ${name} object to be updated in QuickBooks (Must include Id and SyncToken fields)
 * @return {Promise<Object>} ${name} object response
 */
async update${upperFirst(name)}(${name}Object) {
  return await this.#update('${name}', ${name}Object);
}
`;
};

const remove = (name) => {
  return `
/**
 * Remove ${upperFirst(name)} entity from QuickBooks
 * 
 * @param {Object|String} idOrEntity - ${name}'s ID or object to be removed from QuickBooks
 * @return {Promise<Object>} ${name} object response
 */
async delete${upperFirst(name)}(idOrEntity) {
  return await this.#delete('${name}', idOrEntity);
}
`;
};

const query = (name) => {
  return `
/**
 * Find ${upperFirst(
   name
 )} entities in QuickBooks, optionally sending parameters to be used as query condition / filter 
 * 
 * @param {Object=|Object[]=} query - object or array of object to be used as query condition / filter
 * @return {Promise<Object>} ${name} object response
 */
async find${pluralize(upperFirst(name))}(query) {
  return await this.#query('${upperFirst(name)}', query);
}
`;
};

const report = (name) => {
  return `
/**
 * Retrieve ${upperFirst(name)} report from QuickBooks
 * 
 * @param {Object=} params - parameter object to be send as condition / filter
 * @return {Promise<Object>} ${name} object response
 */
async report${upperFirst(name)}(params) {
  return await this.#report('${name}', params);
}
`;
};

const funcDef = {
  get: read,
  find: query,
  delete: remove,
  create,
  update,
  report,
};

const generate = async () => {
  let generatedCode = header;
  forEach(apiList, (value, key) => forEach(value, (entity) => (generatedCode += funcDef[key](entity))));
  generatedCode += footer;

  const eslint = new ESLint({ fix: true });
  const [formattedCode] = await eslint.lintText(generatedCode);

  await fs.writeFile(new URL('./accounting.js', import.meta.url), formattedCode.source || formattedCode.output);
};

await generate();

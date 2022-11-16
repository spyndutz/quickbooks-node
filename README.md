# quickbooks-node
An unofficial `Pure ESM` NodeJS Client for Intuit QuickBooks V3 API inspired by less-maintained [node-quickbooks](https://github.com/mcohen01/node-quickbooks) package. Similar but slightly different exposed API.  
If you're still using CommonJS `require`, please read this [resource](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c) on how to import ESM package.  
Please note that this package is still on unstable version so any minor version change might break the implementation.  
You'll need to at least use Node version >=14.18.0 to be able to use this package.  
## Installation

To install this package to your node project: (Change `#<ref>` with the specified tag/release)
```
  npm install spyndutz/quickbooks-node#<ref>
```

## Usage
For OAuth and handling the token, please use [intuit-oauth](https://github.com/intuit/oauth-jsclient) package provided by the Intuit.  
This package return same response structure specified by Intuit QuickBooks API Documentation, except that if it's a create, read or update API, it directly return the Object/Array inside `entity` key.  
This package only support promise-style API.  

### Import
```javascript
// ESM
import { QuickBooksAccountingClient } from 'quickbooks-node';
// CJS (In async context)
const { QuickBooksAccountingClient } = await import('quickbooks-node');
```
  
### Create new instance
#### QuickBooksAccountingClient(config)

__Arguments__
- `config: object?` - Configurable object

__Config Object__
- `accessToken: string` - User's generated access token
- `realmId: string` - User's company realmId
- `minorVersion: number?` - (Optional) minor version of QuickBooks Online API to be used (Default value: 65)
- `useSandbox: boolean?` - (Optional) boolean flags to use sandbox environment (Default value: If `NODE_ENV === 'production'` false, else true)
- `debug: boolean?` - (Optional) boolean flags to toggle http request log (Default value: If `NODE_ENV === 'production'` false, else true)

```javascript
const qbo = new QuickBooksAccountingClient({
  accessToken: '<accessToken>',
  realmId: '<realmId>',
  minorVersion: 65,
  useSandbox: true,
  debug: false
});
```

### Helper function
#### Get Instance Access Token
```javascript
let accessToken = qbo.getAccessToken();
```
#### Update Instance Access Token
```javascript
qbo.setAccessToken(accessToken);
```

### API Usage
#### API List




### Error Handling
Any constructor error that happens is likely happened because the parameters that you send to create the instance are invalid. Please refer to [usage](#usage) on how to build a correct Client instance.  
Any API error from the request process is returned directly as an `AxiosError` (Package that we use to perform http request), so you need to handle them yourselves.  Please refer to [Axios Handling Error](https://github.com/axios/axios/tree/v1.1.3#handling-errors) section to understand the error object stucture.  
Please report to the issue if there's non `AxiosError` that happens since this version is still unstable, I can't guarantee it covered any errors that could happen.
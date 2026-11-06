import {execute} from './execute.mjs';

self.onmessage = ({data: {source,input,files}}) => {
  try {
    execute(source,input,event => self.postMessage(event),files);
    self.postMessage({kind:'done'});
  } catch (error) {
    self.postMessage({kind:'error',text:error.message});
  }
};
import {
  createPCBFillWorkerProcessor,
  type PCBFillWorkerRequest,
  type PCBFillWorkerResponse,
} from './pcbFillWorkerProtocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PCBFillWorkerRequest>) => void) | null;
  postMessage(response: PCBFillWorkerResponse): void;
};
const processRequest = createPCBFillWorkerProcessor();
scope.onmessage = ({ data }) => {
  const response = processRequest(data);
  if (response) scope.postMessage(response);
};

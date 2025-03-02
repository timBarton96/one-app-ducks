/*
 * Copyright 2019 American Express Travel Related Services Company, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License
 * is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,either express
 * or implied. See the License for the specific language governing permissions and limitations
 * under the License.
 */

/* eslint no-bitwise: ["error", { "int32Hint": true }] -- disable no-bitwise */
import { fromJS } from 'immutable';
import typeScope from './utils/typeScope';

// action constants
export const ADD_ERROR_REPORT_TO_QUEUE = `${typeScope}/error-reporting/ADD_ERROR_REPORT_TO_QUEUE`;
export const SCHEDULE_ERROR_REPORT = `${typeScope}/error-reporting/SCHEDULE_ERROR_REPORT`;

// CALL_API constants
export const SEND_ERROR_REPORT_REQUEST = `${typeScope}/error-reporting/SEND_ERROR_REPORT_REQUEST`;
export const SEND_ERROR_REPORT_SUCCESS = `${typeScope}/error-reporting/SEND_ERROR_REPORT_SUCCESS`;
export const SEND_ERROR_REPORT_FAILURE = `${typeScope}/error-reporting/SEND_ERROR_REPORT_FAILURE`;

const DEFAULT_REQUEST_WAIT = 500; // ms
const MAX_RETRY = 10e3;

const defaultState = fromJS({
  queue: [],
  pending: [],
  pendingPromise: null,
  retryWait: DEFAULT_REQUEST_WAIT,
});

export function formatErrorReport(error, otherData) {
  return {
    msg: error && error.message,
    // TODO: use StackTrace to format the stack?
    stack: error && error.stack, // IE >= 10
    href: global.BROWSER ? global.location.href : undefined,
    otherData,
  };
}

// eslint-disable-next-line default-param-last -- reducers have default params first
export default function errorReportingReducer(state = defaultState, action) {
  const stateQueue = state.get('queue');
  const statePending = state.get('pending');

  switch (action.type) {
    case ADD_ERROR_REPORT_TO_QUEUE:
      if (!(action.error || action.otherData)) {
        console.warn('no error xor otherData given to report, probably due to localhost quirks');
        return state;
      }
      return state.set(
        'queue',
        stateQueue.push(fromJS(formatErrorReport(action.error, action.otherData)))
      );

    case SEND_ERROR_REPORT_REQUEST:
      return state
        .set('pending', stateQueue)
        .set('pendingPromise', action.promise)
        .set('queue', fromJS([]));

    case SEND_ERROR_REPORT_SUCCESS:
      return state
        .set('retryWait', DEFAULT_REQUEST_WAIT)
        .set('pending', fromJS([]))
        .set('pendingPromise', null);

    case SEND_ERROR_REPORT_FAILURE:
      return state
        .set('pending', fromJS([]))
        // eslint-disable-next-line unicorn/prefer-spread -- use concatination
        .set('queue', stateQueue.concat(statePending))
        .set('pendingPromise', null);

    case SCHEDULE_ERROR_REPORT:
      return state
        .set('pendingPromise', action.promise)
        .set(
          'retryWait',
          Math.min(state.get('retryWait') * (1.25 + (Math.random() / 3)) | 0, MAX_RETRY)
        );

    default:
      return state;
  }
}

function getPendingPromise(state) {
  return state.getIn(['errorReporting', 'pendingPromise']);
}

export function serverSideError(queue) {
  // eslint-disable-next-line unicorn/prefer-spread -- use concatination
  [].concat(queue).forEach((raw) => {
    const {
      msg, stack, otherData,
    } = raw;
    const err = new Error(msg);
    Object.assign(err, {
      stack,
      metaData: { ...otherData },
    });
    console.error(err);
  });
  return Promise.resolve({ thankYou: true });
}

function thenSendErrorReport({
  promise, dispatch, getState, fetchClient,
}) {
  return promise
    .then(() => {
      const state = getState();
      const reportingUrl = state.getIn(['config', 'reportingUrl']);
      const queue = state.getIn(['errorReporting', 'queue']).toJS();

      if (queue.length === 0) {
        return null;
      }

      let requestPromise;
      if (global.BROWSER) {
        requestPromise = fetchClient(reportingUrl, {
          method: 'post',
          body: JSON.stringify(queue),
          headers: {
            'Content-Type': 'application/json',
          },
        }).then((response) => {
          if (response.ok) {
            const textResponse = response.clone();
            const jsonResponse = response.clone();
            return jsonResponse.json()
              .catch(() => textResponse.text());
          }
          return Promise.reject(response);
        });
      } else {
        requestPromise = serverSideError(queue);
      }
      // eslint-disable-next-line no-promise-executor-return -- we want to return setTimeout
      const delayPromise = new Promise((resolve) => setTimeout(resolve, DEFAULT_REQUEST_WAIT));
      dispatch({
        type: SEND_ERROR_REPORT_REQUEST,
        payload: JSON.stringify(queue),
        promise: Promise.all([requestPromise, delayPromise]),
      });

      return requestPromise;
    })
    .then((body) => {
      dispatch({
        type: SEND_ERROR_REPORT_SUCCESS,
        data: body,
      });
      return body;
    })
    .catch(() => {
      // catch the error to prevent looping
      // and attempt a retry
      const retryPromise = new Promise((res) => {
        setTimeout(() => res(), getState().getIn(['errorReporting', 'retryWait']));
      });

      dispatch({
        type: SCHEDULE_ERROR_REPORT,
        promise: thenSendErrorReport({
          promise: retryPromise, dispatch, getState, fetchClient,
        }),
      });
      return retryPromise;
    });
}

export function sendErrorReport() {
  // FIXME: figure out how to debounce (min waiting time between processing queues)
  return function getSendErrorReportPromise(dispatch, getState, { fetchClient }) {
    const pendingPromise = getPendingPromise(getState());

    if (pendingPromise) {
      // there's already a request out
      return thenSendErrorReport({
        promise: pendingPromise, dispatch, getState, fetchClient,
      });
    }

    return thenSendErrorReport({
      promise: Promise.resolve(), dispatch, getState, fetchClient,
    });
  };
}

export function addErrorToReport(error, otherData) {
  return function addToQueueAndScheduleReport(dispatch) {
    dispatch({
      type: ADD_ERROR_REPORT_TO_QUEUE,
      error,
      otherData,
    });

    return dispatch(sendErrorReport());
  };
}

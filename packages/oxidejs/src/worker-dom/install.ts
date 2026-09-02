/** Side-effect import: install Worker DOM before any user worker module evaluates. */
import { ensureWorkerDom } from "../worker-dom";

ensureWorkerDom();

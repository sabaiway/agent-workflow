import { guardChecker } from '../../references/scripts/shared/index.mjs';

const LINE_FEED = '\n';

export const runCheckerTail = ({ name, exitCode, remedy }, run, host) => {
  const answer = guardChecker({ name, exitCode, remedy }, run);
  const writeAnswer = (result) => {
    const lines = result.lines ?? result.stdout.split(LINE_FEED);
    const text = lines.join(LINE_FEED);
    if (text.length) host.stdout.write(text.endsWith(LINE_FEED) ? text : `${text}${LINE_FEED}`);
    const code = result.code ?? result.exitCode;
    host.exitCode = code;
    return code;
  };
  return answer instanceof Promise ? answer.then(writeAnswer) : writeAnswer(answer);
};

import { pathToFileURL } from 'node:url';

export function getSydneyPublishingDecision({
	now = new Date(),
	eventName = 'schedule',
	publishingHours = [6, 11, 16, 19],
} = {}) {
	const formatter = new Intl.DateTimeFormat('en-AU', {
		timeZone: 'Australia/Sydney',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	});
	const parts = formatter.formatToParts(now);
	const get = (type) => parts.find((part) => part.type === type)?.value || '';
	const hour = Number(get('hour'));
	const localStamp = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
	const isManual = eventName === 'workflow_dispatch';
	const shouldRun = isManual || publishingHours.includes(hour);

	return {
		shouldRun,
		isManual,
		hour,
		localStamp,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const decision = getSydneyPublishingDecision({
		eventName: process.env.GITHUB_EVENT_NAME || 'schedule',
	});
	process.stdout.write(`should_run=${decision.shouldRun}\n`);
	process.stdout.write(`local_stamp=${decision.localStamp}\n`);
	process.stdout.write(`is_manual=${decision.isManual}\n`);
}

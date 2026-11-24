"""Fake-clock schedules and offline Banner responses; no live HTTP or SQL."""
import fcntl
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import requests

from src import checker

TERMS = ['202690', '202710']
COUNTS = {'courses': 0, 'sections': 0, 'status_changes': 0}
FIXTURES = json.loads((Path(__file__).parent / 'fixtures/banner-snapshots.json').read_text())


class FakeClock:
    def __init__(self, wall=0):
        self.wall = wall
        self.elapsed = 0
        self.waits = []

    def time(self):
        return self.wall

    def monotonic(self):
        return self.elapsed

    def advance(self, seconds):
        self.wall += seconds
        self.elapsed += seconds

    def wait(self, seconds):
        self.waits.append(seconds)
        self.advance(seconds)
        return False


class ScheduledCheckerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'rotation.json'
        self.clock = FakeClock()
        self.watched = []
        self.targets = patch.object(checker, 'get_monitoring_targets', side_effect=lambda **kw: list(self.watched)).start()
        self.fetch = patch.object(checker, 'get_sections', return_value=[]).start()
        self.submit = patch.object(checker, 'submit_department_snapshot', return_value=COUNTS).start()
        self.addCleanup(patch.stopall)
        self.scheduler = self.make_scheduler()

    def make_scheduler(self, departments=None, terms=None, delay=5):
        departments = departments or ['CS', 'IT']
        return checker.ScheduledChecker(terms or TERMS, departments,
                                       checker.RotationCursor(self.path, departments), delay,
                                       clock=self.clock, wait=self.clock.wait)

    def at(self, seconds):
        self.clock.advance(seconds - self.clock.time())

    def test_exact_boundaries_for_both_schedules_and_hour_rollover(self):
        for second in range(0, 7200):
            for kind, period, offset in (('regular', 1800, 0), ('watched', 600, 300)):
                tick = checker.next_tick(second, kind, inclusive=True)
                self.assertGreaterEqual(tick, second)
                self.assertEqual((tick - offset) % period, 0)
                self.assertLess(tick - second, period)
        for now, kind, expected in ((0, 'regular', 1800), (1800, 'regular', 3600),
                                     (300, 'watched', 900), (3300, 'watched', 3900)):
            self.assertEqual(checker.next_tick(now, kind), expected)
        self.assertEqual(checker.next_tick(1800.001, 'regular', inclusive=True), 3600)

    def test_each_loop_runs_only_at_its_wall_clock_boundaries(self):
        for kind, expected in (('regular', [1800, 3600, 5400]), ('watched', [300, 900, 1500])):
            self.clock = FakeClock(1)
            scheduler = self.make_scheduler()
            calls = []
            def slot(category, tick):
                calls.append((category, tick, self.clock.time()))
                if len(calls) == 3:
                    scheduler.stop.set()
            scheduler.run_slot = slot
            scheduler.run_loop(kind)
            self.assertEqual(calls, [(kind, tick, tick) for tick in expected])

    def test_two_terms_one_department_and_five_second_completion_gap(self):
        def fetch(subject, term):
            starts.append((subject, term, self.clock.monotonic()))
            self.clock.advance(2)
            return []
        starts = []
        self.fetch.side_effect = fetch
        self.scheduler.run_slot('regular', 0)
        self.assertEqual(starts, [('CS', TERMS[0], 0), ('CS', TERMS[1], 7)])
        self.assertEqual(self.scheduler.cursor.next_subject, 'IT')
        self.assertEqual(self.submit.call_count, 2)
        self.targets.assert_called_with(watched_only=True)

    def test_no_watches_skip_priority_work_and_leave_regular_rotation_enabled(self):
        self.at(300)
        self.scheduler.run_slot('watched', 300)
        self.fetch.assert_not_called()
        self.submit.assert_not_called()
        self.assertEqual(self.scheduler.cursor.next_subject, 'CS')
        self.at(1800)
        self.scheduler.run_slot('regular', 1800)
        self.assertEqual([call.args for call in self.submit.call_args_list], [('CS', term, []) for term in TERMS])
        self.assertEqual(self.scheduler.cursor.next_subject, 'IT')

    def test_both_watched_terms_still_advance_rotation_once(self):
        self.watched = [{'subject': 'CS', 'term': term} for term in TERMS]
        self.scheduler.run_slot('regular', 0)
        self.fetch.assert_not_called()
        self.assertEqual(self.scheduler.cursor.next_subject, 'IT')
        self.at(1800)
        self.scheduler.run_slot('regular', 1800)
        self.assertEqual([call.args for call in self.fetch.call_args_list], [('IT', term) for term in TERMS])
        self.assertEqual(self.scheduler.cursor.next_subject, 'CS')

    def test_promotion_demotion_and_per_term_exclusion(self):
        scheduler = self.make_scheduler(departments=['CS'])
        self.watched = [{'subject': 'CS', 'term': TERMS[0]}]
        scheduler.run_slot('regular', 0)
        self.assertEqual(self.fetch.call_args.args, ('CS', TERMS[1]))
        self.at(300)
        scheduler.run_slot('watched', 300)
        self.assertEqual(self.fetch.call_args.args, ('CS', TERMS[0]))
        self.watched = []
        self.at(900)
        scheduler.run_slot('watched', 900)
        self.assertEqual(self.fetch.call_count, 2)
        self.at(1800)
        scheduler.run_slot('regular', 1800)
        self.assertEqual([call.args for call in self.fetch.call_args_list][-2:], [('CS', term) for term in TERMS])

    def test_deduplication_and_filtering_to_njit_and_configured_terms(self):
        self.watched = [{'subject': 'CS', 'term': TERMS[0]}] * 3 + [
            {'subject': 'R120', 'term': TERMS[0]}, {'subject': 'CS', 'term': '202795'}]
        self.at(300)
        self.scheduler.run_slot('watched', 300)
        self.fetch.assert_called_once_with('CS', TERMS[0])

    def test_membership_is_rechecked_before_fetch_after_batch_discovery(self):
        self.targets.side_effect = [[{'subject': 'CS', 'term': TERMS[0]}], []]
        self.at(300)
        self.scheduler.run_slot('watched', 300)
        self.fetch.assert_not_called()

    def test_pacing_is_shared_between_regular_and_watched_and_handles_wall_clock_changes(self):
        self.scheduler.delay = 8
        self.scheduler.synchronize(('CS', TERMS[0]), 'regular')
        self.watched = [{'subject': 'IT', 'term': TERMS[1]}]
        self.clock.wall -= 100  # monotonic time still requires the full gap
        self.scheduler.synchronize(('IT', TERMS[1]), 'watched')
        self.assertEqual(self.clock.waits, [8])
        self.assertEqual(self.fetch.call_count, 2)

    def test_request_failure_is_not_retried_and_next_request_is_paced(self):
        self.fetch.side_effect = [requests.Timeout('fixture timeout'), []]
        with self.assertLogs(checker.logger):
            self.scheduler.run_slot('regular', 0)
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(self.clock.waits, [5])
        self.submit.assert_called_once_with('CS', TERMS[1], [])

    def test_targets_api_failure_does_not_guess_membership_or_fetch_banner(self):
        self.targets.side_effect = requests.ConnectionError('fixture failure')
        with self.assertLogs(checker.logger) as logs:
            self.scheduler.run_slot('regular', 0)
            self.scheduler.run_slot('watched', 300)
        self.fetch.assert_not_called()
        self.submit.assert_not_called()
        self.assertIn('Could not load watched targets: fixture failure', logs.records[-1].getMessage())
        self.assertEqual(self.scheduler.cursor.next_subject, 'IT')

    def test_empty_success_malformed_failure_and_failed_submission(self):
        self.scheduler.synchronize(('CS', TERMS[0]), 'regular')
        self.submit.assert_called_once_with('CS', TERMS[0], [])
        self.fetch.return_value = FIXTURES['partial']
        with self.assertLogs(checker.logger):
            self.scheduler.synchronize(('CS', TERMS[1]), 'regular')
        self.assertEqual(self.submit.call_count, 1)
        self.fetch.return_value = FIXTURES['valid']
        self.submit.side_effect = requests.HTTPError('fixture HTTP 503')
        with self.assertLogs(checker.logger):
            self.scheduler.synchronize(('CS', TERMS[1]), 'regular')
        self.assertEqual(self.submit.call_count, 2)

    def test_cursor_survives_restart_and_never_replays_completed_slot(self):
        self.scheduler.run_slot('regular', 0)
        restarted = self.make_scheduler()
        self.assertEqual(restarted.cursor.next_subject, 'IT')
        restarted.run_slot('regular', 0)
        self.assertEqual(self.fetch.call_count, 2)
        self.at(1800)
        restarted.run_slot('regular', 1800)
        self.assertEqual([call.args for call in self.fetch.call_args_list][-2:], [('IT', term) for term in TERMS])
        self.assertEqual(json.loads(self.path.read_text()), {'next_subject': 'CS', 'last_slot': 1800})

    def test_corrupt_cursor_is_preserved_and_failed_completion_keeps_old_cursor(self):
        self.path.write_text('{')
        with self.assertRaisesRegex(checker.CursorStateError, 'refusing to reset'):
            self.make_scheduler()
        self.assertEqual(self.path.read_text(), '{')
        self.path.unlink()
        self.scheduler.cursor.complete(0)
        original = self.path.read_bytes()
        self.at(1800)
        self.scheduler.regular_due = 1800
        with patch.object(checker.os, 'replace', side_effect=OSError('fixture disk failure')):
            with self.assertLogs(checker.logger):
                self.scheduler.run_loop('regular')
        self.assertTrue(self.scheduler.failed)
        self.assertEqual(self.fetch.call_count, 2)  # work finishes before persistence
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_cursor_is_unchanged_until_all_terms_have_been_attempted(self):
        self.scheduler.cursor.complete(0)
        previous = self.path.read_bytes()
        seen = []
        def fetch(subject, term):
            seen.append((subject, term))
            self.assertEqual(self.path.read_bytes(), previous)
            self.assertEqual(self.scheduler.cursor.next_subject, 'IT')
            return []
        self.fetch.side_effect = fetch
        self.at(1800)
        self.scheduler.run_slot('regular', 1800)
        self.assertEqual(seen, [('IT', term) for term in TERMS])
        self.assertEqual(json.loads(self.path.read_text()), {'next_subject': 'CS', 'last_slot': 1800})

    def test_mid_slot_crash_retries_same_department_after_restart(self):
        self.scheduler.cursor.complete(0)
        original = self.path.read_bytes()
        self.at(1800)
        self.fetch.side_effect = [[], KeyboardInterrupt()]
        with self.assertRaises(KeyboardInterrupt):
            self.scheduler.run_slot('regular', 1800)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertFalse(self.scheduler.regular_pending)
        restarted = self.make_scheduler()
        self.assertEqual(restarted.cursor.next_subject, 'IT')
        self.fetch.side_effect = None
        self.fetch.reset_mock()
        self.at(3600)
        restarted.run_slot('regular', 3600)
        self.assertEqual([call.args for call in self.fetch.call_args_list], [('IT', term) for term in TERMS])
        self.assertEqual(restarted.cursor.next_subject, 'CS')

    def test_first_slot_crash_does_not_create_a_premature_cursor(self):
        self.fetch.side_effect = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.scheduler.run_slot('regular', 0)
        self.assertFalse(self.path.exists())
        self.assertEqual(self.make_scheduler().cursor.next_subject, 'CS')

    def test_failed_term_does_not_block_next_department(self):
        self.fetch.side_effect = [requests.Timeout('fixture timeout'), [], [], []]
        with self.assertLogs(checker.logger):
            self.scheduler.run_slot('regular', 0)
        self.assertEqual(self.scheduler.cursor.next_subject, 'IT')
        self.at(1800)
        self.scheduler.run_slot('regular', 1800)
        self.assertEqual([call.args for call in self.fetch.call_args_list],
                         [('CS', TERMS[0]), ('CS', TERMS[1]), ('IT', TERMS[0]), ('IT', TERMS[1])])

    def test_interrupted_shutdown_retains_cursor_for_incomplete_slot(self):
        def fetch(*args):
            self.scheduler.stop.set()
            return []
        self.fetch.side_effect = fetch
        self.scheduler.run_slot('regular', 0)
        self.assertFalse(self.path.exists())
        self.assertEqual(self.scheduler.cursor.next_subject, 'CS')

    def test_slow_watched_batch_finishes_then_skips_missed_ticks(self):
        self.watched = [{'subject': subject, 'term': TERMS[0]} for subject in ('CS', 'IT')]
        self.clock.advance(300)
        times = []
        def slow(subject, term):
            times.append(self.clock.time())
            self.clock.advance(1201)
            if len(times) == 3:
                self.scheduler.stop.set()
            return []
        self.fetch.side_effect = slow
        self.scheduler.run_loop('watched')
        self.assertEqual(times, [300, 1506, 3300])  # finish batch; :15/:25/:35/:45 skipped
        self.assertEqual([call.args[0] for call in self.fetch.call_args_list], ['CS', 'IT', 'CS'])

    def test_slow_regular_slot_advances_only_for_executed_slots(self):
        ticks = []
        def slot(kind, tick):
            ticks.append(tick)
            self.scheduler.cursor.complete(tick)
            self.clock.advance(3900)
            if len(ticks) == 2:
                self.scheduler.stop.set()
        self.scheduler.run_slot = slot
        self.scheduler.run_loop('regular')
        self.assertEqual(ticks, [0, 5400])
        self.assertEqual(self.scheduler.cursor.next_subject, 'CS')

    def test_suspension_skips_old_tick_and_backward_jump_does_not_replay(self):
        self.clock = FakeClock(1)
        scheduler = self.make_scheduler()
        calls = []
        original_wait = self.clock.wait
        jumped = False
        def wait(seconds):
            nonlocal jumped
            if not jumped:
                self.clock.advance(4000)
                jumped = True
                return False
            return original_wait(seconds)
        scheduler.wait = wait
        def slot(kind, tick):
            calls.append(tick)
            if len(calls) == 1:
                self.clock.wall -= 100
            else:
                scheduler.stop.set()
        scheduler.run_slot = slot
        scheduler.run_loop('regular')
        self.assertEqual(calls, [5400, 7200])

    def test_concurrent_callers_cannot_overlap_fetch_or_submit(self):
        first_started = threading.Event()
        second_attempted = threading.Event()
        release_first = threading.Event()
        activity = []
        active = 0
        activity_lock = threading.Lock()
        self.watched = [{'subject': 'CS', 'term': TERMS[0]}]
        def fetch(*pair):
            nonlocal active
            with activity_lock:
                active += 1
                activity.append(('fetch', active))
            if not first_started.is_set():
                first_started.set()
                if not release_first.wait(2):
                    raise AssertionError('test did not release request')
            return []
        def submit(*args):
            nonlocal active
            with activity_lock:
                activity.append(('submit', active))
                active -= 1
            return COUNTS
        self.fetch.side_effect = fetch
        self.submit.side_effect = submit
        first = threading.Thread(target=self.scheduler.synchronize, args=(('CS', TERMS[0]), 'watched'))
        def second_call():
            second_attempted.set()
            self.scheduler.synchronize(('CS', TERMS[0]), 'watched')
        second = threading.Thread(target=second_call)
        try:
            first.start()
            self.assertTrue(first_started.wait(2))
            second.start()
            self.assertTrue(second_attempted.wait(2))
            self.assertEqual(self.fetch.call_count, 1)
        finally:
            release_first.set()
            first.join(2)
            if second.ident is not None:
                second.join(2)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(activity, [('fetch', 1), ('submit', 1), ('fetch', 1), ('submit', 1)])
        self.assertEqual(self.clock.waits, [5])

    def test_large_watched_batch_yields_to_due_regular_before_next_target(self):
        departments = ['CS'] + [f'D{index:02}' for index in range(15)]
        self.scheduler = self.make_scheduler(departments=departments)
        self.watched = [{'subject': subject, 'term': TERMS[0]} for subject in departments]
        self.at(1799)
        self.scheduler.regular_loop_active = True
        self.scheduler.regular_due = 1800
        first_started = threading.Event()
        release_first = threading.Event()
        watched_yielded = threading.Event()
        release_regular_loop = threading.Event()
        order = []
        finishes = []
        failures = []
        gate_wait = self.scheduler.banner_gate.wait
        def observe_gate(timeout=None):
            if threading.current_thread().name == 'watched-test':
                watched_yielded.set()
            return gate_wait(timeout)
        def wait(seconds):
            if threading.current_thread().name == 'regular-test' and not self.scheduler.regular_pending:
                release_regular_loop.wait(3)
                return self.scheduler.stop.is_set()
            return self.clock.wait(seconds)
        self.scheduler.wait = wait
        def fetch(subject, term):
            order.append((subject, term, self.clock.monotonic()))
            if len(order) == 1:
                first_started.set()
                if not release_first.wait(3):
                    raise AssertionError('request not released')
            self.clock.advance(1)
            return []
        def submit(subject, term, sections):
            finishes.append((subject, term, self.clock.monotonic()))
            return COUNTS
        self.fetch.side_effect = fetch
        self.submit.side_effect = submit
        def watched_batch():
            try:
                self.scheduler.run_slot('watched', 1500)
            except BaseException as error:
                failures.append(error)
        watched = threading.Thread(target=watched_batch, name='watched-test')
        regular = threading.Thread(target=self.scheduler.run_loop, args=('regular',), name='regular-test')
        with patch.object(self.scheduler.banner_gate, 'wait', side_effect=observe_gate):
            try:
                watched.start()
                self.assertTrue(first_started.wait(3))
                self.at(1800)
                release_first.set()
                # The regular loop has not run yet. The due epoch alone must
                # stop a second watched dispatch, without relying on lock fairness.
                self.assertTrue(watched_yielded.wait(3))
                self.assertEqual(len(order), 1)
                # Even a late-waking regular thread must honor its published
                # due slot before the next watched target can dispatch.
                self.assertEqual(self.clock.time(), 1801)
                regular.start()
                watched.join(3)
                self.assertFalse(watched.is_alive())
            finally:
                self.scheduler.stop.set()
                release_first.set()
                release_regular_loop.set()
                with self.scheduler.banner_gate:
                    self.scheduler.banner_gate.notify_all()
                if watched.ident is not None:
                    watched.join(3)
                if regular.ident is not None:
                    regular.join(3)
        self.assertFalse(regular.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual([(subject, term) for subject, term, _ in order[:3]],
                         [('CS', TERMS[0]), ('CS', TERMS[1]), ('D00', TERMS[0])])
        self.assertEqual(len(order), len(departments) + 1)
        for previous, following in zip(finishes, order[1:]):
            self.assertGreaterEqual(following[2] - previous[2], 5)
        self.assertEqual([(subject, term) for subject, term, _ in finishes[:2]],
                         [('CS', TERMS[0]), ('CS', TERMS[1])])

    def test_already_running_watched_request_finishes_before_pending_regular_slot(self):
        self.watched = [{'subject': 'IT', 'term': TERMS[0]}]
        started = threading.Event()
        finish_request = threading.Event()
        regular_waiting = threading.Event()
        order = []
        failures = []
        gate_wait = self.scheduler.banner_gate.wait
        def observe_wait(timeout=None):
            regular_waiting.set()
            return gate_wait(timeout)
        def fetch(subject, term):
            order.append(('fetch', subject, term))
            if subject == 'IT':
                started.set()
                if not finish_request.wait(3):
                    raise AssertionError('request not released')
            return []
        def submit(subject, term, sections):
            order.append(('submit', subject, term))
            return COUNTS
        self.fetch.side_effect = fetch
        self.submit.side_effect = submit
        def run(action):
            try:
                action()
            except BaseException as error:
                failures.append(error)
        watched = threading.Thread(target=run, args=(lambda: self.scheduler.synchronize(('IT', TERMS[0]), 'watched'),))
        regular = threading.Thread(target=run, args=(lambda: self.scheduler.run_slot('regular', 1800),))
        with patch.object(self.scheduler.banner_gate, 'wait', side_effect=observe_wait):
            try:
                watched.start()
                self.assertTrue(started.wait(3))
                regular.start()
                self.assertTrue(regular_waiting.wait(3))
                self.assertTrue(self.scheduler.regular_pending)
                self.assertEqual(order, [('fetch', 'IT', TERMS[0])])
            finally:
                finish_request.set()
                watched.join(3)
                if regular.ident is not None:
                    regular.join(3)
        self.assertFalse(watched.is_alive())
        self.assertFalse(regular.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(order[:3], [('fetch', 'IT', TERMS[0]), ('submit', 'IT', TERMS[0]),
                                    ('fetch', 'CS', TERMS[0])])
        self.assertEqual(self.clock.waits, [5, 5])

    def test_watched_yields_if_regular_becomes_due_during_membership_lookup(self):
        self.at(1799)
        self.scheduler.regular_loop_active = True
        self.scheduler.regular_due = 1800
        def targets(**kwargs):
            self.clock.advance(1)
            return [{'subject': 'IT', 'term': TERMS[0]}]
        self.targets.side_effect = targets
        def yield_gate(timeout=None):
            self.scheduler.stop.set()
        with patch.object(self.scheduler.banner_gate, 'wait', side_effect=yield_gate) as waited:
            self.scheduler.synchronize(('IT', TERMS[0]), 'watched')
        waited.assert_called_once()
        self.fetch.assert_not_called()

    def test_watched_yields_if_regular_becomes_due_during_pacing(self):
        self.at(1799)
        self.scheduler.regular_loop_active = True
        self.scheduler.regular_due = 1800
        self.scheduler.next_banner_at = self.clock.monotonic() + 5
        self.watched = [{'subject': 'IT', 'term': TERMS[0]}]
        yielded = []
        original_wait = self.scheduler.banner_gate.wait
        def gate_wait(timeout=None):
            yielded.append(self.clock.time())
            self.scheduler.stop.set()
            return original_wait(0)
        with patch.object(self.scheduler.banner_gate, 'wait', side_effect=gate_wait):
            self.scheduler.synchronize(('IT', TERMS[0]), 'watched')
        self.assertEqual(yielded, [1804])
        self.fetch.assert_not_called()

    def test_corrupt_startup_halts_without_workers_and_preserves_file(self):
        self.path.write_text('invalid cursor evidence')
        with patch.object(checker, 'LOG_FILE', self.path.parent / 'checker.log'), \
             patch.object(checker, 'setup_logging'), \
             patch.object(checker, 'configuration', return_value=(TERMS, 5, ['CS', 'IT'])), \
             patch.object(checker, 'wait_for_cursor_repair', return_value=1) as halt, \
             patch.object(checker.threading, 'Thread') as worker:
            self.assertEqual(checker.main(), 1)
        halt.assert_called_once()
        worker.assert_not_called()
        self.assertEqual(self.path.read_text(), 'invalid cursor evidence')
        self.fetch.assert_not_called()

    def test_corrupt_halt_logs_and_waits_for_operator_instead_of_exiting_immediately(self):
        stopped = Mock()
        with patch.object(checker.threading, 'Event', return_value=stopped), \
             patch.object(checker.signal, 'signal') as handler, self.assertLogs(checker.logger) as logs:
            self.assertEqual(checker.wait_for_cursor_repair(checker.CursorStateError('invalid cursor')), 1)
        stopped.wait.assert_called_once_with()
        self.assertEqual(handler.call_count, 2)
        self.assertIn('Scheduler halted', logs.output[0])
        self.assertIn('Invalid cursor preserved', logs.output[0])
        self.fetch.assert_not_called()

    def test_stop_discards_waiting_work_without_fetching(self):
        self.scheduler.next_banner_at = 2000
        def wait(seconds):
            self.scheduler.stop.set()
            return True
        self.scheduler.wait = wait
        self.scheduler.synchronize(('CS', TERMS[0]), 'regular')
        self.fetch.assert_not_called()
        self.scheduler.synchronize(('CS', TERMS[0]), 'regular')
        self.fetch.assert_not_called()

    def test_stop_during_target_lookup_does_not_start_banner(self):
        def targets(**kwargs):
            self.scheduler.stop.set()
            return []
        self.targets.side_effect = targets
        self.scheduler.synchronize(('CS', TERMS[0]), 'regular')
        self.fetch.assert_not_called()

    def test_main_starts_two_named_loops_sharing_one_checker(self):
        seen = []
        def loop(instance, kind):
            seen.append((id(instance), threading.current_thread().name, kind))
        with patch.object(checker, 'LOG_FILE', self.path.parent / 'checker.log'), \
             patch.object(checker, 'setup_logging'), \
             patch.object(checker, 'configuration', return_value=(TERMS, 5, ['CS', 'IT'])), \
             patch.object(checker.ScheduledChecker, 'run_loop', autospec=True, side_effect=loop):
            self.assertEqual(checker.main(), 0)
        self.assertEqual({(name, kind) for _, name, kind in seen},
                         {('regular', 'regular'), ('watched', 'watched')})
        self.assertEqual(len({identity for identity, _, _ in seen}), 1)
        self.fetch.assert_not_called()

    def test_startup_rejects_duplicate_process_in_same_data_directory(self):
        with (self.path.parent / 'checker.lock').open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(checker, 'LOG_FILE', self.path.parent / 'checker.log'), \
                 patch.object(checker, 'setup_logging'), \
                 patch.object(checker, 'configuration', return_value=(TERMS, 5, ['CS', 'IT'])), \
                 self.assertLogs(checker.logger):
                self.assertEqual(checker.main(), 1)
        self.fetch.assert_not_called()

    def test_logging_defaults_to_the_compose_file_and_can_use_stderr(self):
        log_file = self.path.parent / 'data' / 'checker.log'
        with patch.object(checker, 'LOG_FILE', log_file), \
             patch.object(checker.logging, 'basicConfig') as configure:
            with patch.dict(os.environ, {'CHECKER_LOG_STDERR': '1'}, clear=True):
                checker.setup_logging()
            self.assertNotIn('filename', configure.call_args.kwargs)
            self.assertFalse(log_file.parent.exists())

            with patch.dict(os.environ, {}, clear=True):
                checker.setup_logging()
            self.assertEqual(configure.call_args.kwargs['filename'], log_file)
            self.assertEqual(configure.call_args.kwargs['encoding'], 'utf-8')
            self.assertTrue(log_file.parent.is_dir())

    def test_term_and_pacing_configuration(self):
        for terms in ('[]', '{}', '["202710","202710"]', '[202710]', '["202711"]',
                      '["202710","202750","202790"]', 'not-json', '["２０２７１０"]'):
            with self.subTest(terms=terms), patch.dict(os.environ, {'CHECKER_TERMS': terms}, clear=True):
                with self.assertRaisesRegex(ValueError, 'CHECKER_TERMS'):
                    checker.configuration()
        for delay in ('4.9', '-1', 'nan', 'inf', 'invalid'):
            with self.subTest(delay=delay), patch.dict(os.environ, {'CHECKER_TERMS': '["202710"]',
                                                                       'BANNER_REQUEST_DELAY': delay}, clear=True):
                with self.assertRaisesRegex(ValueError, 'BANNER_REQUEST_DELAY'):
                    checker.configuration()
        with patch.dict(os.environ, {'CHECKER_TERMS': json.dumps(TERMS), 'BANNER_REQUEST_DELAY': '7.5'}, clear=True):
            terms, delay, departments = checker.configuration()
            self.assertEqual((terms, delay), (TERMS, 7.5))
            self.assertEqual(len(departments), 82)


if __name__ == '__main__':
    unittest.main()

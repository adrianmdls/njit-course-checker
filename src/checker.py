"""Two wall-clock scheduling loops share serialized Banner synchronization."""

import logging
import fcntl
import json
import math
import os
import time
import signal
import tempfile
import threading
from pathlib import Path

import requests

from src.checker_api import get_monitoring_targets, submit_department_snapshot
from src.njit_scraper import get_sections, parse_all_sections


LOG_FILE = Path(__file__).resolve().parent.parent / "data" / "checker.log"
logger = logging.getLogger(__name__)


def check_once(persist_state=True):
    """Fetch complete snapshots, optionally submitting them to Express."""
    try:
        targets = get_monitoring_targets()
    except (requests.RequestException, ValueError) as error:
        logger.error("Could not load monitoring targets: %s", error)
        return [f"ERROR: Could not load monitoring targets: {error}"], 1, None

    if not targets:
        return ["No departments configured for monitoring."], 0, None

    results = []
    errors = 0
    for target in targets:
        subject, term = target["subject"], target["term"]
        try:
            sections = parse_all_sections(get_sections(subject, term))
            if persist_state:
                counts = submit_department_snapshot(subject, term, sections)
                message = (
                    f"{subject} {term}: synchronized {counts['courses']} courses, "
                    f"{counts['sections']} sections, {counts['status_changes']} status changes."
                )
                logger.info(message)
            else:
                message = f"{subject} {term}: retrieved {len(sections)} sections (read-only)."
            results.append(message)
        except (requests.RequestException, ValueError, KeyError, TypeError) as error:
            errors += 1
            logger.error("Department check failed for %s %s: %s", subject, term, error)
            results.append(f"ERROR: Department {subject}, term {term}: {error}")

    terms = {target["term"] for target in targets}
    return results, errors, next(iter(terms)) if len(terms) == 1 else None


def setup_logging():
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_FILE,
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        encoding="utf-8",
    )


# Epoch boundaries also fall on :00/:30 and :05/:15/... in America/New_York,
# including DST transitions. Tick and cursor slot identities are epochs.
SCHEDULES = {"regular": (1800, 0), "watched": (600, 300)}


def next_tick(now, kind, inclusive=False):
    period, offset = SCHEDULES[kind]
    tick = (math.floor((now - offset) / period) + 1) * period + offset
    return tick - period if inclusive and now == tick - period else tick


def configuration():
    try:
        terms = json.loads(os.environ.get("CHECKER_TERMS", "[]"))
        if (not isinstance(terms, list) or not 1 <= len(terms) <= 2
                or any(not isinstance(term, str) or len(term) != 6 or not term.isascii()
                       or not term.isdigit() or term[-2:] not in ("10", "50", "90", "95") for term in terms)
                or len(set(terms)) != len(terms)):
            raise ValueError
    except (ValueError, TypeError):
        raise ValueError("CHECKER_TERMS must be a JSON array of one or two distinct Banner term strings.") from None
    try:
        delay = float(os.environ.get("BANNER_REQUEST_DELAY", "5"))
        if not math.isfinite(delay) or delay < 5:
            raise ValueError
    except ValueError:
        raise ValueError("BANNER_REQUEST_DELAY must be finite and at least 5 seconds.") from None
    departments = json.loads(Path(__file__).with_name("departments.json").read_text())
    if (not isinstance(departments, list) or not departments
            or any(not isinstance(code, str) or not code.isascii() or not code.isalnum()
                   or not code[0].isalpha() or code != code.upper() or len(code) > 10 for code in departments)
            or len(set(departments)) != len(departments)):
        raise ValueError("Invalid department allowlist.")
    return terms, delay, departments


class CursorStateError(ValueError):
    """Existing cursor needs operator attention; never reset it automatically."""


class RotationCursor:
    """Persist the next subject only after a department slot has been handled."""

    def __init__(self, path, departments):
        self.path = Path(path)
        self.departments = departments
        self.next_subject = departments[0]
        self.last_slot = -1
        try:
            state = json.loads(self.path.read_text())
        except FileNotFoundError:
            return
        except (OSError, ValueError):
            raise CursorStateError("Cannot read rotation cursor; refusing to reset it.") from None
        if (not isinstance(state, dict) or state.get("next_subject") not in departments
                or type(state.get("last_slot")) is not int or state["last_slot"] < 0
                or state["last_slot"] % 1800 != 0):
            raise CursorStateError("Invalid rotation cursor; refusing to reset it.")
        self.next_subject, self.last_slot = state["next_subject"], state["last_slot"]

    def select(self, slot):
        return self.next_subject if slot > self.last_slot else None

    def complete(self, slot):
        subject = self.select(slot)
        if subject is None:
            return
        following = self.departments[(self.departments.index(subject) + 1) % len(self.departments)]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, delete=False) as stream:
                temporary = Path(stream.name)
                json.dump({"next_subject": following, "last_slot": slot}, stream)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        self.next_subject, self.last_slot = following, slot
        return subject


class ScheduledChecker:
    """Two serial loops; one lock covers fetch, strict parsing and submission."""

    def __init__(self, terms, departments, cursor, delay=5, *, clock=time, stop=None, wait=None):
        self.terms = terms
        self.departments = departments
        self.cursor = cursor
        self.delay = delay
        self.clock = clock
        self.stop = stop if stop is not None else threading.Event()
        self.wait = wait if wait is not None else self.stop.wait
        self.banner_gate = threading.Condition()
        self.banner_active = False
        self.regular_pending = False
        self.regular_loop_active = False
        self.regular_due = next_tick(self.clock.time(), "regular", inclusive=True)
        self.next_banner_at = 0
        self.failed = False

    def watched_pairs(self):
        return sorted({(target["subject"], target["term"])
                       for target in get_monitoring_targets(watched_only=True)
                       if target["subject"] in self.departments and target["term"] in self.terms})

    def regular_has_priority(self):
        # The due timestamp also covers a delayed regular thread that has not
        # yet announced its slot. All gate state is accessed under the condition.
        return self.regular_pending or (self.regular_loop_active and self.clock.time() >= self.regular_due)

    def synchronize(self, pair, kind):
        while not self.stop.is_set():
            with self.banner_gate:
                while self.banner_active or (kind == "watched" and self.regular_has_priority()):
                    if self.stop.is_set():
                        return
                    self.banner_gate.wait(timeout=0.1)
                if self.stop.is_set():
                    return
                self.banner_active = True
            try:
                while not self.stop.is_set():
                    remaining = self.next_banner_at - self.clock.monotonic()
                    if remaining <= 0:
                        break
                    if self.wait(remaining):
                        return
                if self.stop.is_set():
                    return
                # A watched target can own the gate while pacing or reading
                # membership when a regular tick arrives. Yield before Banner.
                with self.banner_gate:
                    if kind == "watched" and self.regular_has_priority():
                        continue
                watched = set(self.watched_pairs())
                if self.stop.is_set() or (kind == "watched") != (pair in watched):
                    return
                with self.banner_gate:
                    if kind == "watched" and self.regular_has_priority():
                        continue
                subject, term = pair
                try:
                    data = get_sections(subject, term)
                finally:
                    self.next_banner_at = self.clock.monotonic() + self.delay
                sections = parse_all_sections(data)
                counts = submit_department_snapshot(subject, term, sections)
                logger.info("%s %s %s: synchronized %s sections", kind, subject, term, counts["sections"])
            except (requests.RequestException, ValueError, KeyError, TypeError) as error:
                logger.error("%s synchronization failed for %s %s: %s", kind, *pair, error)
            finally:
                with self.banner_gate:
                    self.banner_active = False
                    self.banner_gate.notify_all()
            return

    def run_slot(self, kind, slot):
        if kind == "regular":
            with self.banner_gate:
                self.regular_pending = True
                self.banner_gate.notify_all()
            try:
                subject = self.cursor.select(slot)
                if subject is None:
                    return
                for term in self.terms:
                    if self.stop.is_set():
                        return
                    self.synchronize((subject, term), kind)
                if not self.stop.is_set():
                    # Expected per-term failures are handled by synchronize;
                    # interruptions/crashes never reach this completion write.
                    self.cursor.complete(slot)
            finally:
                with self.banner_gate:
                    self.regular_pending = False
                    self.banner_gate.notify_all()
        else:
            try:
                pairs = self.watched_pairs()
            except (requests.RequestException, ValueError, KeyError, TypeError) as error:
                logger.error("Could not load watched targets: %s", error)
                return
            for pair in pairs:
                if self.stop.is_set():
                    return
                self.synchronize(pair, kind)

    def run_loop(self, kind):
        tick = self.regular_due if kind == "regular" else next_tick(self.clock.time(), kind, inclusive=True)
        if kind == "regular":
            with self.banner_gate:
                self.regular_loop_active = True
                self.regular_due = tick
                self.banner_gate.notify_all()
        try:
            while not self.stop.is_set():
                remaining = tick - self.clock.time()
                if remaining > 0:
                    if self.wait(min(remaining, 30)):
                        break
                    continue
                # A regular slot already published to the watched gate remains
                # eligible until the following regular tick, even if its thread
                # wakes late. Fully missed intervals are still discarded.
                grace = SCHEDULES[kind][0] if kind == "regular" else 1
                if self.clock.time() < tick + grace:
                    self.run_slot(kind, tick)
                else:
                    logger.info("Skipped missed %s tick", kind)
                tick = next_tick(max(tick, self.clock.time()), kind)
                if kind == "regular":
                    with self.banner_gate:
                        self.regular_due = tick
                        self.banner_gate.notify_all()
        except Exception as error:
            logger.error("%s scheduling stopped (%s)", kind, type(error).__name__)
            self.failed = True
            self.stop.set()
        finally:
            if kind == "regular":
                with self.banner_gate:
                    self.regular_loop_active = False
                    self.banner_gate.notify_all()


def wait_for_cursor_repair(error):
    """Stay alive but do no work, avoiding Docker's automatic restart loop."""
    logger.error("Scheduler halted: %s Invalid cursor preserved. Stop the checker, "
                 "back up and repair rotation.json, then restart. See "
                 "docs/phase-2-sync.md#cursor-recovery. No Banner work will run.", error)
    stopped = threading.Event()
    previous = signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    try:
        stopped.wait()
    except KeyboardInterrupt:
        pass
    finally:
        signal.signal(signal.SIGTERM, previous)
    return 1


def main():
    setup_logging()
    try:
        terms, delay, departments = configuration()
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with (LOG_FILE.parent / "checker.lock").open("a") as lock_file:
            try:
                fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("Another checker is using this data directory.") from None
            try:
                cursor = RotationCursor(LOG_FILE.parent / "rotation.json", departments)
            except CursorStateError as error:
                return wait_for_cursor_repair(error)
            checker = ScheduledChecker(terms, departments, cursor, delay)
            previous = signal.signal(signal.SIGTERM, lambda *_: checker.stop.set())
            # Publish regular eligibility before either thread can dispatch.
            checker.regular_loop_active = True
            workers = [threading.Thread(target=checker.run_loop, args=(kind,), name=kind)
                       for kind in SCHEDULES]
            try:
                for worker in workers:
                    worker.start()
                while any(worker.is_alive() for worker in workers):
                    for worker in workers:
                        worker.join(timeout=0.5)
            except KeyboardInterrupt:
                checker.stop.set()
            finally:
                checker.stop.set()
                for worker in workers:
                    if worker.ident is not None:
                        worker.join()
                signal.signal(signal.SIGTERM, previous)
            return int(checker.failed)
    except (ValueError, OSError) as error:
        logger.error("Checker startup failed: %s", error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

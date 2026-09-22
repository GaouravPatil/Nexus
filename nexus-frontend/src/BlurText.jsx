import { motion } from 'motion/react';
import { useEffect, useRef, useState, useMemo } from 'react';

const buildKeyframes = (from, steps) => {
    const keys = new Set([...Object.keys(from), ...steps.flatMap(s => Object.keys(s))]);

    const keyframes = {};
    keys.forEach(k => {
        keyframes[k] = [from[k], ...steps.map(s => s[k])];
    });
    return keyframes;
};

const BlurText = ({
    text = '',
    delay = 200,
    className = '',
    animateBy = 'words',
    direction = 'top',
    threshold = 0.1,
    rootMargin = '0px',
    animationFrom,
    animationTo,
    easing = t => t,
    onAnimationComplete,
    stepDuration = 0.35
}) => {
    const elements = animateBy === 'words' ? text.split(' ') : text.split('');
    const [inView, setInView] = useState(true);
    const ref = useRef(null);

    useEffect(() => {
        if (!ref.current) return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setInView(true);
                    observer.unobserve(ref.current);
                }
            },
            { threshold, rootMargin }
        );
        observer.observe(ref.current);
        return () => observer.disconnect();
    }, [threshold, rootMargin]);

    const defaultFrom = useMemo(
        () =>
            direction === 'top' ? { filter: 'blur(10px)', opacity: 0, y: -50 } : { filter: 'blur(10px)', opacity: 0, y: 50 },
        [direction]
    );

    const defaultTo = useMemo(
        () => [
            {
                filter: 'blur(5px)',
                opacity: 0.5,
                y: direction === 'top' ? 5 : -5
            },
            { filter: 'blur(0px)', opacity: 1, y: 0 }
        ],
        [direction]
    );

    const fromSnapshot = animationFrom ?? defaultFrom;
    const toSnapshots = animationTo ?? defaultTo;

    const stepCount = toSnapshots.length + 1;
    const totalDuration = stepDuration * (stepCount - 1);
    const times = Array.from({ length: stepCount }, (_, i) => (stepCount === 1 ? 0 : i / (stepCount - 1)));

    // Perf: keyframes are identical for every word/char — build once, not N
    // times per render. (Previously rebuilt inside the map below, adding
    // main-thread work to the loading phase.)
    const animateKeyframes = useMemo(
        () => buildKeyframes(fromSnapshot, toSnapshots),
        [fromSnapshot, toSnapshots]
    );

    // Perf: honour reduced-motion — skip the blur-filter animation entirely
    // (blur keyframes are the most expensive part of this effect).
    const prefersReducedMotion = useMemo(
        () =>
            typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        []
    );

    if (prefersReducedMotion) {
        return (
            <p ref={ref} className={className} style={{ display: 'flex', flexWrap: 'wrap' }}>
                {text}
            </p>
        );
    }

    return (
        <p ref={ref} className={className} style={{ display: 'flex', flexWrap: 'wrap' }}>
            {elements.map((segment, index) => {
                const spanTransition = {
                    duration: totalDuration,
                    times,
                    delay: (index * delay) / 1000
                };
                spanTransition.ease = easing;

                return (
                    <motion.span
                        className="inline-block will-change-[transform,filter,opacity]"
                        key={index}
                        initial={fromSnapshot}
                        animate={inView ? animateKeyframes : fromSnapshot}
                        transition={spanTransition}
                        onAnimationComplete={index === elements.length - 1 ? onAnimationComplete : undefined}
                    >
                        {segment === ' ' ? '\u00A0' : segment}
                        {animateBy === 'words' && index < elements.length - 1 && '\u00A0'}
                    </motion.span>
                );
            })}
        </p>
    );
};

export default BlurText;